import {test} from 'node:test';import assert from 'node:assert/strict';
import {generateScenario} from '../src/scenario/engine.js';import {findGroup} from '../src/miz/authoring.js';import {luaArray} from '../src/miz/lua.js';import {closeSession} from '../src/miz/sessions.js';
test('scenario generation retains selected template offsets instead of silently substituting a column',()=>{
 const result=generateScenario({name:'Layout',kind:'cas',theatre:'Caucasus',coalitions:{blue:['USA'],red:['Russia']},player:{group:'Player'},objective:'Inspect the selected layout',forces:[{name:'Player',side:'blue',country:'USA',category:'plane',type:'F-16C_50',position:{x:0,y:0},role:'CAS'},{name:'Site',side:'red',country:'Russia',category:'vehicle',type:'rapier_fsa_blindfire_radar',site:'Rapier',position:{x:10000,y:20000},heading:0}],victory:[{kind:'time_after',seconds:10}]});
 try{const units=luaArray(findGroup(result.session.mission,'Site')!.group.units);assert.equal(Number(units[1].x),10000);assert.equal(Number(units[1].y),19964);assert.equal(Number(units[2].x),10001.9);assert.equal(Number(units[2].y),19919.2);}finally{closeSession(result.session.id);}
});
