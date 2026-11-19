/** Revision-correlated observations. Qualitative checks stay unknown. */
import {open,stat} from 'node:fs/promises';
import {defaultLogPath,parseLog,findProblems} from '../dcs/log.js';
import {bridgeRequest,type BridgeOptions,type BridgeRequest} from '../bridge/client.js';
import {type ProductionPlan,type Revision} from './schema.js';
import {sha256} from './store.js';
import path from 'node:path';
export type EvidenceQuery=(request:BridgeRequest,options:BridgeOptions)=>Promise<unknown>;
export interface CaptureOptions {logPath?:string;host?:string;port?:number;}
const array=(value:unknown):any[]=>Array.isArray(value)?value:[];
export function evaluateChecks(plan:ProductionPlan,runtime:any,problems:unknown[],outcomeFlag?:number){
 return plan.checks.map(check=>{const c=check.criterion;let observed=false,known=true;
  if(c.kind==='manual')known=false;
  else if(c.kind==='log_clean')observed=problems.length===0;
  else if(c.kind==='scenario_outcome'){const value=outcomeFlag?runtime.flags?.[String(outcomeFlag)]:undefined;known=typeof value==='number'&&Number.isFinite(value);observed=known&&value===(c.value==='victory'?1:2);}
  else if(c.kind==='flag_equals'){const value=runtime.flags?.[String(c.flag)];known=typeof value==='number'&&Number.isFinite(value);observed=known&&value===c.value;}
  else if(c.kind==='event'){known=runtime.eventMonitoring?.available===true;observed=known&&array(runtime.events).some(e=>e.kind===c.event&&(!c.initiator||e.initiator===c.initiator)&&(!c.place||e.place===c.place));}
  else {const g=array(runtime.groups).find(g=>g.name===c.group);known=!!g&&typeof g.exists==='boolean';
   if(c.kind==='group_exists')observed=known&&g.exists;
   else {const units=array(g?.units);known=known&&g.exists&&units.length>0&&units.every(u=>typeof u.life==='number'&&typeof u.active==='boolean'&&(c.kind!=='group_on_ground'||typeof u.inAir==='boolean'));
    observed=known&&units.every(u=>u.life>0&&u.active&&(c.kind!=='group_on_ground'||u.inAir===false));}}
  return {id:check.id,description:check.description,status:!known?'unknown':observed?'observed':'not_observed',criterion:c};
 });
}
async function logTail(file:string){const st=await stat(file);if(!st.isFile())throw new Error('DCS log is not a regular file');const handle=await open(file,'r');try{const bytes=Buffer.alloc(Math.min(st.size,1024*1024));const start=Math.max(0,st.size-bytes.length);const result=await handle.read(bytes,0,bytes.length,start);return {text:bytes.subarray(0,result.bytesRead).toString('utf8'),truncated:start>0};}finally{await handle.close();}}
export async function collectFlightObservation(plan:ProductionPlan,revision:Revision,missionPath:string,options:CaptureOptions,query:EvidenceQuery=bridgeRequest){
 const bridge={host:options.host??'127.0.0.1',port:options.port??8899,timeoutMs:5000};
 const expected=path.basename(missionPath,'.miz');
 const ready=(value:any)=>{if(value?.phase!=='running'||value?.missionEnv!==true||value?.mission!==expected)throw new Error('Live mission identity does not match this revision, or mission is not running');};
 const before=await query({cmd:'status'},bridge);ready(before);
 const groups=[...new Set(plan.checks.flatMap(c=>'group' in c.criterion?[c.criterion.group]:[]))];
 const flags=[...new Set(plan.checks.flatMap(c=>c.criterion.kind==='flag_equals'?[String(c.criterion.flag)]:c.criterion.kind==='scenario_outcome'&&revision.outcomeFlag?[String(revision.outcomeFlag)]:[]))];
 const runtime:any=await query({cmd:'runtime',args:{groups,flags,afterSequence:0}},bridge);
 const eventPages:any[]=[];
 let page=runtime;
 for(let i=0;i<2&&page?.eventMonitoring?.truncated===true;i++){
  const events=array(page.events),cursor=events.at(-1)?.sequence;
  if(!Number.isSafeInteger(cursor)||cursor<1)throw new Error('Truncated event page has no usable cursor');
  const next:any=await query({cmd:'runtime',args:{groups:[],flags:[],afterSequence:cursor}},bridge);
  if(typeof next?.time!=='number'||next.time<runtime.time||next.eventMonitoring?.available!==true||next.eventMonitoring.latestSequence<cursor)throw new Error('Mission/event history changed during evidence capture');
  eventPages.push(next);page=next;
 }
 if(eventPages.length){const all=[...array(runtime.events),...eventPages.flatMap(p=>array(p.events))];runtime.events=[...new Map(all.map(e=>[e.sequence,e])).values()];runtime.eventCollection={pages:eventPages.length+1,lastTime:page.time,truncated:page.eventMonitoring?.truncated===true,historyGap:runtime.eventMonitoring?.historyGap===true||eventPages.some(p=>p.eventMonitoring?.historyGap===true)};}
 const after=await query({cmd:'status'},bridge);ready(after);
 if(!runtime||typeof runtime.time!=='number'||!Number.isFinite(runtime.time)||runtime.time<0||runtime.theatre!==plan.theatre)throw new Error('Runtime snapshot is missing mission time or matching theatre');
 const file=options.logPath??defaultLogPath(),tail=await logTail(file);
 const markerIndex=tail.text.lastIndexOf('[DCSMCP_PRODUCTION]');
 if(markerIndex<0||!tail.text.slice(markerIndex).startsWith(revision.logMarker))throw new Error('Latest production revision marker does not match the selected revision');
 const correlated=tail.text.slice(markerIndex),problems=findProblems(parseLog(correlated));
 const checks=evaluateChecks(plan,runtime,problems,revision.outcomeFlag);
 return {version:1,projectId:revision.projectId,revisionId:revision.id,revision:revision.number,missionDigest:revision.digest,capturedAt:new Date().toISOString(),
  correlation:'Unique mission filename + latest production log marker + local saved-archive SHA-256. This is correlation, not simulator byte attestation.',
  bridgeBefore:before,bridgeAfter:after,runtime,
  log:{sourcePath:file,tailTruncated:tail.truncated,sha256:sha256(correlated),text:correlated,problems},checks,
  allDeclaredChecksObserved:checks.every(c=>c.status==='observed'),
  limitation:'Only these declared checks at this observation are evaluated. Manual checks, full AI tactics, radio service quality and overall playability are not inferred.'};
}
