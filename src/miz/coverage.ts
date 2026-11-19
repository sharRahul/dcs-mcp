/** Evidence-bounded aircraft coverage and carrier recovery planning. */
import {findUnitType,unitTypes,type FlyingType} from '../data/reference.js';
import {aircraftCoverageProfileSchema,type AircraftCoverageProfile} from '../data/coverage-profile.js';
import {authoringData} from '../data/authoring.js';
import {radioInfo} from './radios.js';
import {loadoutsFor} from '../dcs/payloads.js';
import {findModUnit} from '../dcs/mods.js';
import {addWaypoint,findGroup,findUnit,findGroupOfUnit} from './authoring.js';
import {asTable,luaArray,type LuaTable} from './lua.js';

const hornet='https://www.digitalcombatsimulator.com/en/products/planes/hornet/';
const supercarrier='https://www.digitalcombatsimulator.com/upload/iblock/e1b/430ooc582lpb0npynbsewan6omd5ohvs/DCS_Supercarrier_Operations_Guide_EN.pdf';
const harrier='https://www.digitalcombatsimulator.com/en/shop/modules/av8bna/';
const westernDecks=['Stennis','CVN_71','CVN_72','CVN_73','CVN_75'];
const tomcats=['F-14A-135-GR','F-14B'];
export function carrierCompatibility(aircraft:string,ship:string) {
 const source=aircraft==='FA-18C_hornet' && westernDecks.includes(ship) ? (ship==='Stennis'?hornet:supercarrier) :
  tomcats.includes(aircraft)&&westernDecks.includes(ship)?supercarrier:
  aircraft==='AV8BNA'&&ship==='LHA_Tarawa'?harrier:undefined;
 return {aircraft,ship,status:source?'supported' as const:'unknown' as const,source:source??null,
  parkingCapacity:authoringData().ships[ship]?.parking??null,
  limitations:['Documented DCS pairing, not deck-slot geometry or a guarantee of successful AI recovery.','Unlisted pairs, helicopters and mods remain unknown.']};
}
/** Append ED Land/Landing + linkUnit/helipadId, exactly as me_route writes it. */
export function addCarrierRecovery(mission:LuaTable,groupName:string,shipName:string,allowUnknown=false){
 const found=findGroup(mission,groupName),ship=findUnit(mission,shipName),shipGroup=findGroupOfUnit(mission,shipName);
 if(!found||!['plane','helicopter'].includes(found.category))throw new Error('Recovery requires an aircraft group');
 if(!ship||shipGroup?.category!=='ship')throw new Error('Recovery requires an existing ship unit');
 if(found.side!==shipGroup.side)throw new Error('Recovery ship belongs to a different coalition');
 if(!Number.isSafeInteger(ship.unitId)||!Number.isFinite(ship.x)||!Number.isFinite(ship.y))throw new Error('Ship requires a valid unit id and finite position');
 const units=luaArray(found.group.units),checks=units.map(u=>carrierCompatibility(String(u.type),String(ship.type)));
 if(checks.some(c=>c.parkingCapacity===0))throw new Error('Ship has no aircraft deck');
 if(!allowUnknown&&checks.some(c=>c.status==='unknown'))throw new Error('Aircraft/deck compatibility unknown; pass allowUnknown=true to author explicitly unverified recovery');
 const points=asTable(asTable(found.group.route)?.points);
 if(luaArray(points).some(p=>p.type==='Land'))throw new Error('Route already has a landing waypoint');
 const waypointIndex=addWaypoint(mission,groupName,{x:Number(ship.x),y:Number(ship.y),altitudeMetres:0,speedMps:0,type:'Land',action:'Landing'});
 const point=asTable(asTable(asTable(found.group.route)?.points)?.[waypointIndex])!;
 point.linkUnit=ship.unitId!;point.helipadId=ship.unitId!;
 return {group:groupName,ship:shipName,shipUnitId:ship.unitId,waypointIndex,compatibility:checks,
  planning:'Ship-linked native DCS recovery; position is initial ship position. DCS resolves the moving deck.',
  verification:'authored; requires observed landing event on the intended deck'};
}
export const SERVICE_DATES=[
 {type:'A-10C',country:'USA',from:2007,source:'https://www.af.mil/News/Article-Display/Article/125890/a-10-thunderbolt-ii-gets-technological-thumbs-up/',basis:'Precision Engagement A-10C IOC in August 2007. Does not establish A-10C II configuration dates; A-10C_2 deliberately excluded.'},
 {type:'F-16C_50',country:'USA',from:1994,source:'https://www.af.mil/About-Us/Fact-Sheets/Display/Article/104505/f-16-fighting-falcon/',basis:'USAF initial operating capability for F-16C/D Block 50-52; not the date of every DCS avionics/store fit.'},
 {type:'FA-18C_hornet',country:'USA',from:1987,source:'https://www.navair.navy.mil/product/FA-18-D-Hornet',basis:'F/A-18C/D operational September 1987; not the date of the simulated Lot/configuration.'},
] as const;
export function serviceDateCheck(type:string,year:number,country?:string){
 if(!Number.isInteger(year)||year<1900||year>2200)throw new Error('Year must be an integer 1900-2200');
 const record=SERVICE_DATES.find(r=>r.type===type&&(!country||r.country===country));
 return {type,year,country:country??null,evaluatedCountry:record?.country??null,status:!record?'unknown':year<record.from?'before_service':'not_before_service',record:record??null,
  limitations:['Earliest-year check only; retirement, country transfers and avionics/store fit dates are unknown.','No record means unknown, never historically valid.']};
}
export function aircraftCoverage(type:string,profile?:AircraftCoverageProfile){
 const evidence=profile?aircraftCoverageProfileSchema.parse(profile):undefined;
 if(evidence&&evidence.type!==type)throw new Error('Profile type must exactly match requested aircraft type');
 const hit=findUnitType(type),mod=findModUnit(type),entry=hit?.entry as unknown as FlyingType|undefined;
 if(hit&&!['plane','helicopter'].includes(hit.category))throw new Error('Type is not an aircraft');
 const data=authoringData().aircraft[type];
 const numeric=(field:'fuelMaxKg'|'width'|'length'|'height')=>field==='fuelMaxKg'?entry?.fuelMax:entry?.[field];
 const supplied=(field:'fuelMaxKg'|'width'|'length'|'height')=>field==='fuelMaxKg'?evidence?.fuelMaxKg:evidence?.dimensionsMetres?.[field];
 const fields=['fuelMaxKg','width','length','height'] as const;
 const fieldSources=Object.fromEntries(fields.map(field=>[field,numeric(field)!=null?{kind:hit?.source??'unknown',source:'data/unit-types.json'}:supplied(field)!=null?{kind:'caller-supplied',source:evidence!.source,scope:evidence!.scope}:null]));
 return {type,category:hit?.category??mod?.category??'unknown',source:hit?.source??(mod?'mod':'unknown'),
  fuelMaxKg:entry?.fuelMax??evidence?.fuelMaxKg??null,dimensionsMetres:{width:entry?.width??evidence?.dimensionsMetres?.width??null,length:entry?.length??evidence?.dimensionsMetres?.length??null,height:entry?.height??evidence?.dimensionsMetres?.height??null},fieldSources,
  tasks:entry?.tasks??null,pylonCount:data?Object.keys(data.pylons??{}).length:null,pylons:data?.pylons??null,
  radios:data?radioInfo(type):null,payloadLibrary:loadoutsFor(type),serviceDates:SERVICE_DATES.filter(r=>r.type===type),
  limitations:['Bundled performance/tasks are a pydcs snapshot. Installed payloads establish configurations, not full aircraft capability.','Missing dimensions, fuel, radios or tasks remain unknown; never borrowed from a similar airframe.','Optional profile is caller-supplied evidence, not independently verified. It fills only missing numeric fields for this report and never changes authoring defaults.']};
}
/** Fast catalogue audit: no payload scanning or capability inference from configurations. */
export function coverageAudit(types?:string[]){
 const ids=[...new Set(types??[...unitTypes().plane,...unitTypes().helicopter].map(t=>t.type))];
 const data=authoringData();
 const rows=ids.map(type=>{
  const hit=findUnitType(type),entry=hit&&['plane','helicopter'].includes(hit.category)?hit.entry as FlyingType:undefined;
  return {type,fuelMaxKg:entry?.fuelMax!=null,dimensionsMetres:[entry?.width,entry?.length,entry?.height].every(v=>v!=null),tasks:!!entry?.tasks?.length,pylons:!!data.aircraft[type]?.pylons&&Object.keys(data.aircraft[type].pylons).length>0,radios:!!data.aircraft[type]&&radioInfo(type).radios.length>0,serviceDates:SERVICE_DATES.some(r=>r.type===type),deckSlotGeometry:false};
 });
 const fields=['fuelMaxKg','dimensionsMetres','tasks','pylons','radios','serviceDates','deckSlotGeometry'] as const;
 return {total:rows.length,known:Object.fromEntries(fields.map(f=>[f,rows.filter(r=>r[f]).length])),rows,serviceDateRecords:SERVICE_DATES.length,limitations:['Presence audit only, not completeness or runtime verification.','Service dates are country-scoped lower bounds; no retirement or configuration validation.','Deck slots and occupied mixed-airframe capacity remain unknown.']};
}
export function historicalReport(mission:LuaTable){
 const year=Number(asTable(mission.date)?.Year);
 const units:{group:string;unit:string;check:ReturnType<typeof serviceDateCheck>}[]=[];
 for(const [side,c] of Object.entries(asTable(mission.coalition)??{}))for(const country of luaArray(asTable(c as LuaTable)?.country))
 for(const category of ['plane','helicopter','vehicle','ship'] as const)for(const group of luaArray(asTable(country[category])?.group))for(const unit of luaArray(group.units))
 units.push({group:String(group.name),unit:String(unit.name),check:serviceDateCheck(String(unit.type),year,String(country.name))});
 return {year,units,unknown:units.filter(u=>u.check.status==='unknown').length,beforeService:units.filter(u=>u.check.status==='before_service').length};
}
