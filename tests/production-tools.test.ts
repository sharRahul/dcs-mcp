import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
async function connect(outputDir:string){const c=new Client({name:'production-test',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/index.ts'],env:{...process.env,DCS_MISSION_OUTPUT_DIR:outputDir,DCS_MCP_STATE_DIR:'off'} as Record<string,string>,stderr:'ignore'}));return c;}
async function call(c:Client,name:string,args:Record<string,unknown>){const r=await c.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r.content));return r.structuredContent as Record<string,any>;}
test('production tools, bundled skill and prompt support persistent revision work over stdio',{timeout:60000},async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'production-mcp-'));const projectDir=path.join(base,'mission');let c=await connect(base);
 try{const tools=(await c.listTools()).tools.map(t=>t.name);const skill=await c.readResource({uri:'dcs://skills/mission-production'});const text=String((skill.contents[0] as any).text);assert.ok(text.includes('dcs_production_capture'));for(const name of new Set(text.match(/dcs_[a-z_]+/g)??[]))assert.ok(tools.includes(name),'Skill names an unavailable tool: '+name);
 const prompt=await c.getPrompt({name:'produce_mission',arguments:{projectDir,objective:'Build and verify an F-16 mission',theatre:'Caucasus'}});assert.equal(prompt.messages[0].role,'user');
 await call(c,'dcs_production_create',{outputDir:projectDir,plan:{name:'MCP proof',theatre:'Caucasus',objective:'Observe an F-16',checks:[{id:'spawn',description:'Player present',criterion:{kind:'group_exists',group:'Player'}}]}});
 const {sessionId}=await call(c,'dcs_miz_new',{theatre:'Caucasus'});await call(c,'dcs_miz_add_aircraft_group',{sessionId,name:'Player',side:'blue',country:'USA',type:'F-16C_50',count:1,x:-284000,y:683000});
 const one=await call(c,'dcs_production_revise',{projectDir,sessionId,expectedRevision:0,notes:'Import initial authored mission'});assert.equal(one.revision.number,1);const original=await readFile(one.revision.missionPath);
 const check=await call(c,'dcs_production_validate',{projectDir,revision:1});assert.equal(check.report.ok,true);
 const opened=await call(c,'dcs_miz_open',{path:one.revision.missionPath});await call(c,'dcs_miz_set_payload',{sessionId:opened.sessionId,unit:'Player-1',fuel:2000});
 const two=await call(c,'dcs_production_revise',{projectDir,sessionId:opened.sessionId,expectedRevision:1,notes:'Change fuel'});assert.equal(two.revision.number,2);assert.deepEqual(await readFile(one.revision.missionPath),original);
 await c.close();c=await connect(base);const status=await call(c,'dcs_production_status',{projectDir});assert.equal(status.currentRevision,2);assert.equal(status.stage,'flight_pending');assert.equal(status.revisions[1].evidenceCount,0);
 const failed=await c.callTool({name:'dcs_production_capture',arguments:{projectDir,revision:2,host:'127.0.0.1',port:1}});assert.equal(failed.isError,true);assert.equal((await call(c,'dcs_production_status',{projectDir})).stage,'flight_pending');
 }finally{await c.close();}
});
