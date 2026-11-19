import {resolveTheatreName} from '../data/reference.js';
/** Plan -> immutable generation/checkpoint -> saved-byte validation -> correlated flight evidence. */
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,rm} from 'node:fs/promises';
import {productionPlanSchema,type Revision} from './schema.js';
import {appendRecord,sha256,directory,missionFile,projectAt,readJson,recordsAt,revisionAt,revisionsAt,stagedRevision,withProjectLock,writeJson} from './store.js';
import {collectFlightObservation,type CaptureOptions,type EvidenceQuery} from './evidence.js';
import {generateScenario,validateScenario} from '../scenario/engine.js';
import {checkMission} from '../acceptance/checks.js';
import {addTrigger,findTriggerByComment,replaceTrigger,type TriggerArgs} from '../miz/authoring.js';
import {closeSession,saveSessionAs,type MissionSession} from '../miz/sessions.js';
import {asTable,luaArray} from '../miz/lua.js';
const MARKER='DCS-MCP production revision';
const note=(notes:string)=>{if(!notes.trim()||notes.length>10000)throw new Error('Revision notes must contain 1..10000 characters');return notes;};
function copySession(source:MissionSession):MissionSession{return {...source,id:randomUUID(),mission:structuredClone(source.mission),dictionary:structuredClone(source.dictionary),mapResource:structuredClone(source.mapResource),
 document:structuredClone(source.document),sourceBytes:Buffer.from(source.sourceBytes),files:new Map([...source.files].map(([name,bytes])=>[name,Buffer.from(bytes)])),warehouses:source.warehouses?structuredClone(source.warehouses):undefined,
 archiveFiles:source.archiveFiles?new Map(source.archiveFiles):undefined,removedEntries:source.removedEntries?new Set(source.removedEntries):undefined};}
export async function createProduction(outputDir:string,input:unknown){const plan=productionPlanSchema.parse(input);const theatre=resolveTheatreName(plan.theatre);if(!theatre)throw new Error('Unknown production theatre');plan.theatre=theatre;const root=path.resolve(outputDir);await mkdir(root);try{await mkdir(path.join(root,'revisions'));await writeJson(path.join(root,'project.json'),{version:1,id:randomUUID(),createdAt:new Date().toISOString(),plan});}catch(e){await rm(root,{recursive:true,force:true});throw e;}return inspectProduction(root);}
async function head(root:string,expected:number){const revisions=await revisionsAt(root);if(!Number.isInteger(expected)||expected!==revisions.length)throw new Error('Production revision conflict: expected '+expected+', current '+revisions.length);if(revisions.length)await revisionAt(root,revisions.length);return revisions;}
async function publish(root:string,projectId:string,source:MissionSession,number:number,notes:string,planDigest:string,specification?:unknown,generationReport?:unknown){
 const victoryIndex=findTriggerByComment(source.mission,'Scenario Victory');
 const rules=luaArray(asTable(asTable(source.mission.trigrules)?.[victoryIndex??-1])?.rules);
 const outcomeRules=rules.filter(r=>r.predicate==='c_flag_equals'&&Number(r.value)===1);
 const candidate=outcomeRules.length===1?Number(outcomeRules[0].flag):NaN;
 const outcomeFlag=Number.isSafeInteger(candidate)&&candidate>0?candidate:undefined;
 const id=randomUUID(),logMarker='[DCSMCP_PRODUCTION] project='+projectId+' revision='+id;
 const copy=copySession(source);copy.mission.dcsMcpProduction={projectId,revisionId:id,number};
 const spec:TriggerArgs={type:'start',comment:MARKER,conditions:[],actions:[{kind:'do_script',text:'env.info('+JSON.stringify(logMarker)+')'}]};
 const existing=findTriggerByComment(copy.mission,MARKER);if(existing)replaceTrigger(copy.mission,copy.dictionary,existing,spec);else addTrigger(copy.mission,spec,copy.dictionary);
 try {const revision=await stagedRevision(root,number,async stage=>{
  const draft={version:1 as const,projectId,id,number,planDigest,outcomeFlag,notes:note(notes),createdAt:new Date().toISOString(),logMarker,digest:''};
  const missionPath=path.join(stage,missionFile(draft));const saved=await saveSessionAs(copy,missionPath);draft.digest=saved.digest;
  const offline=await checkMission(missionPath);await mkdir(path.join(stage,'checks'));await mkdir(path.join(stage,'evidence'));
  await appendRecord(stage,'checks',{version:1,revisionId:id,missionDigest:saved.digest,checkedAt:new Date().toISOString(),report:offline});
  if(specification)await writeJson(path.join(stage,'specification.json'),specification);if(generationReport)await writeJson(path.join(stage,'generation-report.json'),generationReport);
  await writeJson(path.join(stage,'revision.json'),draft);return draft;
 });return {revision:await publicRevision(root,revision)};
 }finally{closeSession(copy.id);}
}
async function publicRevision(root:string,revision:Revision){const stored=await revisionAt(root,revision.number);const checks=await recordsAt(stored.folder,'checks'),evidence=await recordsAt(stored.folder,'evidence');
 const validChecks=checks.filter(c=>c.revisionId===revision.id&&c.missionDigest===revision.digest),validEvidence=evidence.filter(e=>e.revisionId===revision.id&&e.projectId===revision.projectId&&e.missionDigest===revision.digest);
 return {...revision,missionPath:stored.missionPath,offline:validChecks.at(-1)?.report??null,evidenceCount:validEvidence.length,latestFlightChecks:validEvidence.at(-1)?.checks??[],declaredChecksObserved:validEvidence.some(e=>e.allDeclaredChecksObserved===true)};
}
export async function generateProduction(projectDir:string,input:unknown,expectedRevision:number,notes:string){note(notes);const {root,project}=await projectAt(projectDir);return withProjectLock(root,async()=>{await head(root,expectedRevision);const spec=validateScenario(input);if(spec.theatre!==project.plan.theatre)throw new Error('Scenario theatre conflicts with production plan');const generated=generateScenario(spec);try{return await publish(root,project.id,generated.session,expectedRevision+1,notes,sha256(JSON.stringify(project.plan)),generated.specification,generated.report);}finally{closeSession(generated.session.id);}});}
export async function reviseProduction(projectDir:string,source:MissionSession,expectedRevision:number,notes:string){note(notes);const {root,project}=await projectAt(projectDir);return withProjectLock(root,async()=>{const revisions=await head(root,expectedRevision);const previous=revisions.at(-1),identity=asTable(source.mission.dcsMcpProduction);if((previous&&(identity?.projectId!==project.id||identity.revisionId!==previous.id))||(!previous&&identity))throw new Error('Edit session source revision does not match this project head');if(previous)await revisionAt(root,previous.number);if(source.mission.theatre!==project.plan.theatre)throw new Error('Edit theatre conflicts with production plan');return publish(root,project.id,source,expectedRevision+1,notes,sha256(JSON.stringify(project.plan)));});}
export async function validateProduction(projectDir:string,number:number){const s=await revisionAt(projectDir,number);return withProjectLock(s.root,async()=>{const verified=await revisionAt(projectDir,number);const report=await checkMission(verified.missionPath);const record={version:1,revisionId:s.revision.id,missionDigest:s.revision.digest,checkedAt:new Date().toISOString(),report};const artifact=await appendRecord(s.folder,'checks',record);return {artifact,...record};});}
export async function captureProductionEvidence(projectDir:string,number:number,options:CaptureOptions={},query?:EvidenceQuery){const s=await revisionAt(projectDir,number);const report=await collectFlightObservation(s.project.plan,s.revision,s.missionPath,options,query);return withProjectLock(s.root,async()=>{await revisionAt(projectDir,number);const artifact=await appendRecord(s.folder,'evidence',report);return {artifact,report};});}
export async function inspectProduction(projectDir:string){const {root,project}=await projectAt(projectDir);const entries=await revisionsAt(root);const revisions=await Promise.all(entries.map(r=>publicRevision(root,r)));const current=revisions.at(-1);
 const stage=!current?'planned':!current.offline?.ok?'validation_failed':current.declaredChecksObserved?'declared_checks_observed':current.evidenceCount?'evidence_partial':'flight_pending';
 const nextActions=stage==='planned'?['Generate a scenario revision from the plan.']:stage==='validation_failed'?['Open the current revision, fix reported errors, checkpoint a new revision.']:stage==='declared_checks_observed'?['Report the exact tested revision, observed checks and remaining qualitative limits.']:['Open the exact current mission file in DCS when live testing is authorized.','Capture native evidence for this revision; inspect unmet/unknown declared checks.'];
 return {projectDir:root,projectId:project.id,plan:project.plan,currentRevision:current?.number??0,stage,revisions,nextActions,limitation:'Evidence applies only to its immutable mission revision; a generated or offline-valid mission is not automatically flight-verified.'};
}
