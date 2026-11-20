import {findAirport} from '../../dist/data/reference.js';
/** Generate an autonomous live check. Does not launch DCS or overwrite missions. */
import path from 'node:path';
import {newSession,refresh,saveSessionAs} from '../../dist/miz/sessions.js';
import {addAircraftGroup,addGroundGroup,addWaypoint,addTrigger,setBriefing} from '../../dist/miz/authoring.js';
import {findSiteTemplate} from '../../dist/miz/templates.js';
import {addCarrierRecovery,aircraftCoverage,historicalReport} from '../../dist/miz/coverage.js';
import {claimStartAirfields,editWarehouse} from '../../dist/miz/logistics.js';
import {loadScripts} from '../../dist/miz/frameworks.js';
import {writeFile} from 'node:fs/promises';
const output=path.resolve(process.argv[2]??'runtime-authoring-verification.miz');
const s=newSession('Caucasus',43200);s.mission.date={Year:2003,Month:6,Day:15};
setBriefing(s.mission,'DCS Sortie MCP autonomous runtime verification','Click FLY. AI Hornet returns to Stennis. At 15 seconds an isolated truck is destroyed to produce real DCS events. Player need not fly.');
addAircraftGroup(s.mission,'plane',{name:'Observer',side:'blue',country:'USA',type:'F-16C_50',count:1,x:0,y:0,start:{kind:'parking_hot',airfield:'Kutaisi'},skill:'Player'});
addGroundGroup(s.mission,'ship',{name:'Carrier',side:'blue',country:'USA',type:'Stennis',count:1,x:-300000,y:400000,heading:90});
addWaypoint(s.mission,'Carrier',{x:-300000,y:440000,speedMps:8});
addAircraftGroup(s.mission,'plane',{name:'Recovery',side:'blue',country:'USA',type:'FA-18C_hornet',count:1,x:-300000,y:380000,heading:90,altitudeMetres:600,speedMps:150,task:'Nothing'});
const recovery=addCarrierRecovery(s.mission,'Recovery','Carrier-1');
for(const [id,name,x,y] of [['me-sa-2-sam-battery','EditorSAM',-284000,684000],['me-flak18-battery','EditorGun',-284000,685000]]){
 const t=findSiteTemplate(id);addGroundGroup(s.mission,'vehicle',{name,side:'blue',country:'USA',type:t.composition[0].type,count:1,x,y,composition:t.composition,offsets:t.offsets,headingOffsetsDegrees:t.headingOffsetsDegrees});
}
addGroundGroup(s.mission,'vehicle',{name:'EventTarget',side:'blue',country:'USA',type:'M 818',count:1,x:-283000,y:684000});
await loadScripts({mission:s.mission,mapResource:s.mapResource,files:s.files},s.dictionary,[{filePath:path.resolve('runtime/dcs/dcs-mcp-telemetry.lua')}]);
addTrigger(s.mission,{type:'once',comment:'Autonomous event proof',conditions:[{kind:'time_after',seconds:15}],actions:[{kind:'do_script',text:"local u=Unit.getByName('EventTarget-1'); if u then trigger.action.explosion(u:getPoint(),1000) end; DCSMCP.trig('AutonomousEventProof')"}]},s.dictionary);
claimStartAirfields(s);s.warehouses=editWarehouse(s,'airports',13,{coalition:'BLUE'},true);
s.warehouses=editWarehouse(s,'airports',findAirport('Caucasus','Kutaisi').id,{suppliers:[{kind:'airports',id:13}]});
refresh(s);await saveSessionAs(s,output);
await writeFile(output+'.json',JSON.stringify({output,recovery,aircraft:aircraftCoverage('FA-18C_hornet'),history:historicalReport(s.mission)},null,2));console.log(output);
