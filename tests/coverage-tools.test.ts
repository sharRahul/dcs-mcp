import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openSession,closeSession} from '../src/miz/sessions.js';
import {findGroup} from '../src/miz/authoring.js';
import {asTable} from '../src/miz/lua.js';
test('coverage, ship recovery, history and new supplier links work through real MCP', {timeout:60000},async()=>{
 const outputDir=mkdtempSync(path.join(tmpdir(),'coverage-mcp-'));
 const client=new Client({name:'coverage-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/index.ts'],env:{...process.env,DCS_MISSION_OUTPUT_DIR:outputDir,DCS_MCP_STATE_DIR:'off'} as Record<string,string>,stderr:'ignore'}));
 const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r.content));return r.structuredContent as Record<string,any>;};
 try{
 assert.equal((await call('dcs_carrier_compatibility',{aircraft:'FA-18C_hornet',ship:'Stennis'})).status,'supported');
 assert.equal((await call('dcs_service_date_check',{type:'F-16C_50',year:1990})).status,'before_service');
 assert.equal((await call('dcs_service_date_check',{type:'F-16C_50',year:2003,country:'Georgia'})).status,'unknown');
 assert.ok((await call('dcs_aircraft_coverage',{type:'F-16C_50'})).pylonCount>0);
 const audit=await call('dcs_authoring_coverage_audit',{types:['F-16C_50','Unknown-Mod']});assert.equal(audit.total,2);assert.equal(audit.rows[1].fuelMaxKg,false);assert.equal(audit.known.deckSlotGeometry,0);
 const profiled=await call('dcs_aircraft_coverage',{type:'Unknown-Mod',profile:{type:'Unknown-Mod',source:'https://example.org/manual',scope:'test release',fuelMaxKg:1234}});assert.equal(profiled.fuelMaxKg,1234);assert.equal(profiled.fieldSources.fuelMaxKg.kind,'caller-supplied');
 const mismatch=await client.callTool({name:'dcs_aircraft_coverage',arguments:{type:'Other',profile:{type:'Unknown-Mod',source:'https://example.org/manual',scope:'test release',fuelMaxKg:1234}}});assert.equal(mismatch.isError,true);
 const {sessionId}=await call('dcs_miz_new',{theatre:'Caucasus'});
 await call('dcs_miz_add_ground_group',{sessionId,category:'ship',name:'Deck',side:'blue',country:'USA',type:'Stennis',count:1,x:-300000,y:400000});
 await call('dcs_miz_add_aircraft_group',{sessionId,name:'Hornet',side:'blue',country:'USA',type:'FA-18C_hornet',count:1,x:-300000,y:380000,altitudeMetres:600});
 const recovery=await call('dcs_miz_add_carrier_recovery',{sessionId,group:'Hornet',ship:'Deck-1'});assert.equal(recovery.waypointIndex,2);
 await call('dcs_miz_edit_warehouse',{sessionId,kind:'airports',id:12,create:true,patch:{coalition:'BLUE'}});
 await call('dcs_miz_edit_warehouse',{sessionId,kind:'airports',id:13,create:true,patch:{coalition:'BLUE'}});
 await call('dcs_miz_edit_warehouse',{sessionId,kind:'airports',id:12,patch:{suppliers:[{kind:'airports',id:13}]}});
 const report=await call('dcs_miz_historical_report',{sessionId});assert.equal(report.units.length,2);
 const output=path.join(outputDir,'verified.miz');await call('dcs_miz_save_as',{sessionId,outPath:output});
 const s=await openSession(output);try{assert.equal(asTable(asTable(asTable(findGroup(s.mission,'Hornet')!.group.route)?.points)?.[2])?.helipadId,recovery.shipUnitId);}finally{closeSession(s.id);}
 }finally{await client.close();}
});
