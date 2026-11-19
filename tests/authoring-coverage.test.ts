import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newMissionTable,addGroundGroup,addAircraftGroup,findGroup} from '../src/miz/authoring.js';
import {asTable,luaArray,parseLuaAssignment} from '../src/miz/lua.js';
import {serializeLuaAssignment} from '../src/miz/serializer.js';
import * as coverage from '../src/miz/coverage.js';
function mission(){const m=newMissionTable('Caucasus',43200);addGroundGroup(m,'ship',{name:'Carrier',side:'blue',country:'USA',type:'Stennis',count:1,x:-200000,y:0});addAircraftGroup(m,'plane',{name:'Hornet',side:'blue',country:'USA',type:'FA-18C_hornet',count:1,x:-210000,y:0,altitudeMetres:2000});return m;}
test('ship recovery links the actual deck and preserves an authored route',()=>{
 const m=mission();const report=(coverage as any).addCarrierRecovery(m,'Hornet','Carrier-1');
 const parsed=parseLuaAssignment(serializeLuaAssignment('mission',m),'mission');const points=asTable(asTable(findGroup(parsed,'Hornet')!.group.route)?.points)!;
 assert.equal(points[2]&&asTable(points[2])?.type,'Land');assert.equal(asTable(points[2])?.linkUnit,report.shipUnitId);assert.equal(asTable(points[2])?.helipadId,report.shipUnitId);assert.equal(asTable(points[2])?.airdromeId,undefined);
 const before=serializeLuaAssignment('mission',m);assert.throws(()=>(coverage as any).addCarrierRecovery(m,'Hornet','Carrier-1'),/already.*landing/i);assert.equal(serializeLuaAssignment('mission',m),before);
});
test('unknown decks or aircraft do not become compatible by default',()=>{
 assert.equal((coverage as any).carrierCompatibility('FA-18C_hornet','Stennis').status,'supported');
 assert.equal((coverage as any).carrierCompatibility('Unknown-Mod','Stennis').status,'unknown');
 assert.equal((coverage as any).carrierCompatibility('FA-18C_hornet','Unknown-Ship').status,'unknown');
});
test('historical checks distinguish exact variant scope from unknown country history',()=>{
 assert.equal((coverage as any).serviceDateCheck('F-16C_50',1990).status,'before_service');
 assert.equal((coverage as any).serviceDateCheck('F-16C_50',2003).status,'not_before_service');
 assert.equal((coverage as any).serviceDateCheck('F-16C_50',2003,'Georgia').status,'unknown');
 assert.equal((coverage as any).serviceDateCheck('unknown',2003).status,'unknown');
 const a=(coverage as any).aircraftCoverage('F-16C_50');assert.ok(a.fuelMaxKg>0);assert.ok(a.tasks.length);assert.ok(a.pylonCount>0);
});

test('missing aircraft data stays unknown rather than claiming zero capability',()=>{
 const a=(coverage as any).aircraftCoverage('Unknown-Mod');assert.equal(a.tasks,null);assert.equal(a.pylonCount,null);assert.equal(a.fuelMaxKg,null);assert.equal(a.radios,null);
});

test('sourced profiles fill unknown numbers without replacing bundled facts',()=>{
 const profile={type:'Unknown-Mod',source:'https://example.org/manual',scope:'Exact mod release 1',fuelMaxKg:1234,dimensionsMetres:{width:10}};
 const a=coverage.aircraftCoverage('Unknown-Mod',profile);assert.equal(a.fuelMaxKg,1234);assert.equal(a.dimensionsMetres.width,10);assert.equal(a.dimensionsMetres.length,null);assert.equal(a.fieldSources.fuelMaxKg.source,profile.source);
 assert.throws(()=>coverage.aircraftCoverage('Other',profile),/type/i);
 assert.throws(()=>coverage.aircraftCoverage('Unknown-Mod',{...profile,fuelMaxKg:-1}),/too_small/i);
 assert.throws(()=>coverage.aircraftCoverage('Unknown-Mod',{...profile,source:'file:///manual'}),/HTTP/i);
 const known=coverage.aircraftCoverage('F-16C_50');assert.equal(coverage.aircraftCoverage('F-16C_50',{...profile,type:'F-16C_50'}).fuelMaxKg,known.fuelMaxKg);
});
test('coverage audit counts only evidence and exposes unknown deck geometry',()=>{
 const a=coverage.coverageAudit(['F-16C_50','Unknown-Mod']);assert.equal(a.total,2);assert.equal(a.rows[1].fuelMaxKg,false);assert.equal(a.rows[1].serviceDates,false);assert.equal(a.rows[0].deckSlotGeometry,false);
 assert.equal(coverage.serviceDateCheck('A-10C',2006,'USA').status,'before_service');assert.equal(coverage.serviceDateCheck('A-10C_2',2008,'USA').status,'unknown');
});
