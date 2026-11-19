import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProduction,generateProduction,reviseProduction,inspectProduction,captureProductionEvidence,validateProduction} from '../src/production/workflow.js';
import {openSession,closeSession} from '../src/miz/sessions.js';
import {findGroup} from '../src/miz/authoring.js';
import {asTable,luaArray} from '../src/miz/lua.js';
const plan={name:'Production proof',theatre:'Caucasus',objective:'Verify a generated mission without stale evidence.',checks:[{id:'spawn',description:'Player exists',criterion:{kind:'group_exists',group:'Player'}},{id:'event',description:'Target dies',criterion:{kind:'event',event:'S_EVENT_DEAD',initiator:'Target-1'}}]};
const spec={name:'Production proof',theatre:'Caucasus',kind:'cas',coalitions:{blue:['USA'],red:['Russia']},player:{group:'Player'},objective:plan.objective,forces:[{name:'Player',side:'blue',country:'USA',category:'plane',type:'F-16C_50',count:1,position:{x:-284000,y:683000},role:'CAS'},{name:'Target',side:'red',country:'Russia',category:'vehicle',type:'T-72B',position:{x:-283000,y:684000}}],victory:[{kind:'time_after',seconds:30}]};
async function project(){const base=await mkdtemp(path.join(tmpdir(),'production-'));const dir=path.join(base,'project');await createProduction(dir,plan);return dir;}
function bridge(revision:any,marker=true){return async(request:any)=> request.cmd==='status'?{phase:'running',missionEnv:true,mission:path.basename(revision.missionPath,'.miz')}:{time:40,theatre:'Caucasus',flags:{},groups:[{name:'Player',exists:true,units:[{name:'Player-1',life:20,inAir:true,active:true}]}],events:[{kind:'S_EVENT_DEAD',initiator:'Target-1',time:15,sequence:1}],eventMonitoring:{available:true,source:'hook_observer',latestSequence:1,oldestSequence:1}};}
async function logFor(dir:string,revision:any){const file=path.join(dir,'flight.log');await writeFile(file,'2026-11-18 22:00:00.000 INFO SCRIPTING (Main): '+revision.logMarker+'\n');return file;}
test('plan to generated revision to evidence survives restart and invalidates on revision',async()=>{
 const dir=await project();assert.equal((await inspectProduction(dir)).stage,'planned');
 const one=await generateProduction(dir,spec,0,'Initial draft');assert.equal(one.revision.number,1);assert.equal((await inspectProduction(dir)).stage,'flight_pending');
 const bytes=await readFile(one.revision.missionPath);const log=await logFor(dir,one.revision);
 const evidence=await captureProductionEvidence(dir,1,{logPath:log},bridge(one.revision));assert.equal(evidence.report.checks.every((c:any)=>c.status==='observed'),true);
 assert.equal((await inspectProduction(dir)).stage,'declared_checks_observed');
 const session=await openSession(one.revision.missionPath);const unit=luaArray(findGroup(session.mission,'Player')!.group.units)[0];unit.payload=structuredClone(asTable(unit.payload)??{});(unit.payload as any).fuel='2000';
 const two=await reviseProduction(dir,session,1,'Changed fuel and opposition');closeSession(session.id);
 assert.equal(two.revision.number,2);assert.equal((await inspectProduction(dir)).stage,'flight_pending');assert.equal((await inspectProduction(dir)).revisions[0].evidenceCount,1);
 assert.deepEqual(await readFile(one.revision.missionPath),bytes);
 await assert.rejects(captureProductionEvidence(dir,2,{logPath:log},bridge(one.revision)),/mission identity|revision marker/i);
});
test('stale edit heads, wrong projects and tampered archives never inherit validation',async()=>{
 const dir=await project();const one=await generateProduction(dir,spec,0,'Initial');
 await assert.rejects(generateProduction(dir,spec,0,'Stale writer'),/revision conflict/i);
 const session=await openSession(one.revision.missionPath);const other=await project();await assert.rejects(reviseProduction(other,session,0,'Wrong project'),/source revision|project/i);closeSession(session.id);
 await writeFile(one.revision.missionPath,'tampered');await assert.rejects(validateProduction(dir,1),/digest|changed/i);
 await assert.rejects(captureProductionEvidence(dir,1,{logPath:await logFor(dir,one.revision)},bridge(one.revision)),/digest|changed/i);
});
test('unmatched or missing logs cannot produce correlated flight evidence',async()=>{
 const dir=await project();const one=await generateProduction(dir,spec,0,'Initial');const log=path.join(dir,'wrong.log');await writeFile(log,'An old mission loaded fine.');
 await assert.rejects(captureProductionEvidence(dir,1,{logPath:log},bridge(one.revision)),/marker/i);
 assert.equal((await inspectProduction(dir)).stage,'flight_pending');
});
test('manual checks remain pending and repeated evidence does not impersonate subjective verification',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'production-manual-'));const dir=path.join(base,'project');await createProduction(dir,{...plan,checks:[...plan.checks,{id:'quality',description:'Radio dialogue is convincing',criterion:{kind:'manual'}}]});
 const one=await generateProduction(dir,spec,0,'Initial');const report=await captureProductionEvidence(dir,1,{logPath:await logFor(dir,one.revision)},bridge(one.revision));
 assert.equal(report.report.checks.find((c:any)=>c.id==='quality').status,'unknown');assert.equal((await inspectProduction(dir)).stage,'evidence_partial');
});
test('concurrent writers cannot overwrite or skip a mission revision',async()=>{
 const dir=await project();const results=await Promise.allSettled([generateProduction(dir,spec,0,'Writer A'),generateProduction(dir,spec,0,'Writer B')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await inspectProduction(dir)).currentRevision,1);
});

test('capture paginates retained native events so a check beyond the first 200 is observable',async()=>{
 const dir=await project();const one=await generateProduction(dir,spec,0,'Initial');const base=bridge(one.revision);let pages=0;
 const query=async(request:any,options:any)=>{const r:any=await base(request);if(request.cmd!=='runtime')return r;pages++;const after=Number(request.args.afterSequence);const events=Array.from({length:230},(_,i)=>({kind:i===229?'S_EVENT_DEAD':'S_EVENT_BIRTH',initiator:i===229?'Target-1':'Other',sequence:i+1,time:15})).filter(e=>e.sequence>after).slice(0,200);return {...r,events,eventMonitoring:{available:true,latestSequence:230,oldestSequence:1,truncated:events.at(-1)?.sequence!==230}};};
 const result=await captureProductionEvidence(dir,1,{logPath:await logFor(dir,one.revision)},query);assert.equal(pages,2);assert.equal(result.report.checks.every((c:any)=>c.status==='observed'),true);assert.equal(result.report.runtime.events.length,230);
});
test('changing acceptance criteria in project metadata invalidates old evidence',async()=>{
 const dir=await project();await generateProduction(dir,spec,0,'Initial');const file=path.join(dir,'project.json');const p=JSON.parse(await readFile(file,'utf8'));p.plan.checks.pop();await writeFile(file,JSON.stringify(p));await assert.rejects(inspectProduction(dir),/plan changed/i);await assert.rejects(generateProduction(dir,spec,1,'Regenerate with changed plan'),/plan changed/i);
});

test('a logical scenario outcome check resolves the generated flag without hard-coding allocator ids',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'production-outcome-'));const dir=path.join(base,'project');await createProduction(dir,{...plan,checks:[{id:'victory',description:'Scenario victory observed',criterion:{kind:'scenario_outcome',value:'victory'}}]});
 const one=await generateProduction(dir,spec,0,'Generated outcome');assert.ok(one.revision.outcomeFlag>0);const basic=bridge(one.revision);
 const result=await captureProductionEvidence(dir,1,{logPath:await logFor(dir,one.revision)},async(req:any,opts:any)=>{const r:any=await basic(req);return req.cmd==='runtime'?{...r,flags:{[one.revision.outcomeFlag]:1}}:r;});assert.equal(result.report.checks[0].status,'observed');
});
