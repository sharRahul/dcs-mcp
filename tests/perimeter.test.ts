import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRectanglePerimeter } from '../src/miz/perimeter.js';
import { addTargetArea } from '../src/miz/dressing.js';
import { newMissionTable, findUnit } from '../src/miz/authoring.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';
import { parseLuaAssignment } from '../src/miz/lua.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSession,closeSession } from '../src/miz/sessions.js';

const base = { side:'blue' as const, country:'USA', name:'Boundary', x:1000, y:2000, widthMetres:60, depthMetres:40 };
test('rotated perimeter leaves requested entrance clear and round-trips real statics', () => {
 const m=newMissionTable('Caucasus',43200);
 const r=addRectanglePerimeter(m,{...base,heading:90,gates:[{edge:'front',offsetMetres:0,widthMetres:12}]});
 const back=parseLuaAssignment(serializeLuaAssignment('mission',m),'mission');
 assert.ok(r.objects.length>20);assert.equal(r.entrances.length,1);
 assert.equal(r.entrances[0].x,1000);assert.equal(r.entrances[0].y,2020);
 for(const segment of r.segments){
  const u=findUnit(back,segment.name)!;assert.equal(u.type,'Twall_x1');assert.equal(u.category,'Fortifications');
  if(segment.edge==='front')assert.ok(segment.localOffsetMetres+segment.spanMetres/2<=-6+1e-8 || segment.localOffsetMetres-segment.spanMetres/2>=6-1e-8,'wall intrudes into entrance');
 }
 assert.ok(r.entrances[0].approach.inside.y<2020 && r.entrances[0].approach.outside.y>2020);
 assert.equal(r.dimensionsVerified,false);
});
test('MCP camp/perimeter tools preserve entrance configuration through save/reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dcs-perimeter-'));
 const client=new Client({name:'perimeter-contract',version:'0'});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/index.ts'],env:{...process.env,DCS_MISSION_OUTPUT_DIR: dir, DCS_MCP_STATE_DIR: 'off'} as Record<string,string>,stderr:'ignore'});
 await client.connect(transport);
 const call=async(name:string,args:Record<string,unknown>)=>{
  const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r.content));return r.structuredContent as any;
 };
 try{
  const {sessionId}=await call('dcs_miz_new',{theatre:'Caucasus'});
  const r=await call('dcs_miz_add_target_area',{sessionId,side:'blue',country:'USA',name:'Camp',template:'barracks',x:0,y:0,zone:true});
  assert.ok(r.perimeter.objects.length>0);assert.equal(r.perimeter.entrances.length,1);
  const standalone=await call('dcs_miz_add_perimeter',{sessionId,side:'blue',country:'USA',name:'ExistingScene',x:500,y:0,widthMetres:60,depthMetres:60,
   gates:[{edge:'front',widthMetres:10},{edge:'rear',widthMetres:8}]});
  assert.equal(standalone.perimeter.entrances.length,2);
  const invalid=await client.callTool({name:'dcs_miz_add_target_area',arguments:{sessionId,side:'blue',country:'USA',name:'Invalid',template:'barracks',x:0,y:0,perimeter:{type:'UNKNOWN_WALL'}}});
  assert.equal(invalid.isError,true);
  await call('dcs_miz_add_trigger_zone',{sessionId,name:'ZoneClash',x:0,y:0,radius:100});
  const zoneClash=await client.callTool({name:'dcs_miz_add_target_area',arguments:{sessionId,side:'blue',country:'USA',name:'ZoneClash',template:'barracks',x:0,y:0,zone:true}});
  assert.equal(zoneClash.isError,true);
  const file=join(dir,'camp.miz');await call('dcs_miz_save_as',{sessionId,outPath:file});
  const s=await openSession(file);
  try{assert.ok(findUnit(s.mission,r.perimeter.objects[0]));assert.equal(findUnit(s.mission,'Invalid-1'),undefined);assert.equal(findUnit(s.mission,'ZoneClash-1'),undefined);}finally{closeSession(s.id);}
 }finally{await client.close();rmSync(dir,{recursive:true,force:true});}
});
test('invalid gates, unknown assets, name collisions and excessive objects leave mission unchanged', () => {
 const m=newMissionTable('Caucasus',43200);addRectanglePerimeter(m,base);
 const before=serializeLuaAssignment('mission',m);
 for(const a of [
  {...base}, {...base,name:'Bad',type:'DoesNotExist'},
  {...base,name:'Bad',gates:[{edge:'front' as const,offsetMetres:29,widthMetres:12}]},
  {...base,name:'Bad',gates:[{edge:'rear' as const,offsetMetres:0,widthMetres:12},{edge:'rear' as const,offsetMetres:4,widthMetres:8}]},
  {...base,name:'Bad',widthMetres:2000,depthMetres:2000,segmentLengthMetres:1},
  {...base,name:'Bad',widthMetres:99,depthMetres:99,segmentLengthMetres:50,gates:[]},
 ]){assert.throws(()=>addRectanglePerimeter(m,a));assert.equal(serializeLuaAssignment('mission',m),before);}
});
test('barracks camps create a perimeter automatically, opt-out works, invalid camps are atomic', () => {
 const m=newMissionTable('Caucasus',43200);
 const args={side:'blue' as const,country:'USA',name:'Camp',template:'barracks',x:0,y:0};
 const r=addTargetArea(m,args);assert.ok(r.perimeter && r.perimeter.objects.length>0);
 assert.equal(r.perimeter.entrances[0].widthMetres,12);
 const open=addTargetArea(m,{...args,name:'OpenCamp',x:1000,perimeter:false});assert.equal(open.perimeter,undefined);
 assert.ok(open.objects.length<r.objects.length);
 const before=serializeLuaAssignment('mission',m);
 assert.throws(()=>addTargetArea(m,{...args,name:'BadCamp',perimeter:{type:'NO_SUCH_WALL'}}));
 assert.equal(serializeLuaAssignment('mission',m),before);
});
