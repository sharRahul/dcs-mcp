/** Shared scenery for both Iron Veil builders. Call after all flight starts exist. */
import { populateAirfield as defaultPopulate } from '../dist/miz/dressing.js';
import { addStatic } from '../dist/miz/editing.js';
import { findUnit, findGroup, occupiedParking } from '../dist/miz/authoring.js';
import { findAirport, findUnitType } from '../dist/data/reference.js';
import { enableInstalledSceneryTypes } from '../dist/dcs/scenery-assets.js';

export function populateIronVeilAirfields(mission, populateAirfield = defaultPopulate, overrides = {}) {
  const d = { addStatic, findUnit, findGroup, occupiedParking, findAirport, findUnitType, enableInstalledSceneryTypes, ...overrides };
  const assets = d.enableInstalledSceneryTypes();
  const copy = structuredClone(mission);
  const manifest = [];
  for (const plan of [
    { airfield: 'Kutaisi', side: 'blue', country: 'USA', prefix: 'KUTAISI', aircraft: ['F-16C_50', 'F-15C', 'UH-1H'], stores: 'ordnance' },
    { airfield: 'Senaki-Kolkhi', side: 'blue', country: 'USA', prefix: 'SENAKI', aircraft: ['UH-1H', 'C-130', 'UH-1H'], stores: 'cargo' },
    { airfield: 'Vaziani', side: 'red', country: 'Russia', prefix: 'VAZIANI', aircraft: ['MiG-29S', 'Su-27', 'Ka-50'], stores: 'ordnance' },
    { airfield: 'Tbilisi-Lochini', side: 'red', country: 'Russia', prefix: 'LOCHINI', aircraft: ['An-26B', 'Mi-8MT', 'An-26B'], stores: 'cargo' },
  ]) {
    const airport = d.findAirport(String(copy.theatre), plan.airfield);
    const placed = [], zones = [], skipped = [];
    const localAssets = new Map(assets.map(a => [a.type, a]));
    const base = { side: plan.side, country: plan.country, dead: false };
    const crew = plan.side === 'blue' ? ['M92_Personnel06_PBR', 'M92_Personnel07_PBR'] : ['VP-MAN_1_Idle', 'VP-MAN_2_Check'];
    // Stand row normal, selecting the side towards the airport reference point.
    // This is an explicit heuristic: the catalogue has no surveyed stand headings.
    const heading = slot => {
      const neighbor = airport.slots.filter(s => s !== slot).sort((a,b) => Math.hypot(a[2]-slot[2],a[3]-slot[3])-Math.hypot(b[2]-slot[2],b[3]-slot[3]))[0];
      let h = Math.atan2(neighbor[3]-slot[3],neighbor[2]-slot[2]) + Math.PI/2;
      if ((airport.x-slot[2])*Math.cos(h)+(airport.y-slot[3])*Math.sin(h)<0) h+=Math.PI;
      return (h*180/Math.PI+360)%360;
    };
    const put = (type, anchor, forward, right, radius, suffix, optional = false, parentAircraft) => {
      if (optional && !localAssets.has(type)) { skipped.push(type); return; }
      if (!d.findUnitType(type)) throw new Error(`Scenery type unavailable: ${type}`);
      // Props stay inside the reserved stand rectangle; no props in rotor/wing boxes.
      const slot = anchor.slot;
      if (Math.abs(forward)+radius>slot[6]/2 || Math.abs(right)+radius>slot[5]/2) return;
      const h=anchor.heading*Math.PI/180;
      const x=anchor.x+forward*Math.cos(h)-right*Math.sin(h), y=anchor.y+forward*Math.sin(h)+right*Math.cos(h);
      const name=`${plan.prefix}_${suffix}`;
      d.addStatic(copy,{...base,name,type,x,y,heading:anchor.heading,hidden:false});
      const asset=localAssets.get(type);
      placed.push({name,type,slot:slot[1],role:anchor.role,parentAircraft,clearanceRadiusMetres:radius,
        ...(asset ? {dependency:asset.file} : {})});
    };
    const aircraft = populateAirfield(copy,{...base,airfield:plan.airfield,types:plan.aircraft,count:plan.aircraft.length,namePrefix:`${plan.prefix}_PARKED_AIRCRAFT`,slots:'open'});
    if (aircraft.placed.length!==plan.aircraft.length) throw new Error(`${plan.airfield}: incomplete parked-aircraft scene`);
    for (const [i,p] of aircraft.placed.entries()) {
      const unit=d.findUnit(copy,p.name), group=d.findGroup(copy,p.name).group;
      const slot=airport.slots.find(s=>s[1]===p.slot), h=heading(slot);
      unit.heading=group.heading=h*Math.PI/180;
      const ref=d.findUnitType(p.type).entry;
      const anchor={x:Number(unit.x),y:Number(unit.y),heading:h,slot,role:'aircraft_service'};
      placed.push({...p,role:'parked_aircraft'});
      // Utility helicopters retain clear rotor footprints; close servicing props
      // are used for fixed wing only, and only where stand space permits them.
      if (d.findUnitType(p.type).category==='plane') {
        put('Ladder',anchor,ref.length*.25,-(ref.width/2+2),1.25,`ACCESS_LADDER_${i}`,false,p.name);
        put('Toolbox01',anchor,0,-(ref.width/2+2),.75,`AIRCRAFT_TOOLS_${i}`,false,p.name);
        put(crew[0],anchor,-ref.length*.2,-(ref.width/2+1.5),.5,`AIRCRAFT_TECH_${i}`,true,p.name);
      }
    }
    const reserve = role => {
      const occupied=d.occupiedParking(copy,airport);
      const slot=airport.slots.filter(s=>!occupied.has(s[1]) && !(s[4]&8) && s[5]>=18 && s[6]>=20)
        .sort((a,b)=>a[1].localeCompare(b[1],undefined,{numeric:true}))[0];
      if(!slot) throw new Error(`${plan.airfield}: no free stand for ${role}`);
      const anchor={x:slot[2],y:slot[3],heading:heading(slot),slot,role};
      // A small central toolbox reserves this shared bay in occupiedParking,
      // allowing multiple props per stand while subsequent bays stay distinct.
      put('Toolbox02',anchor,0,0,.75,`${role.toUpperCase()}_BAY_MARKER`);
      zones.push({role,slot:slot[1],x:anchor.x,y:anchor.y,headingDegrees:anchor.heading});
      return anchor;
    };
    const service=reserve('servicing');
    put(plan.side==='blue'?'AM32a-60_01':'Ural-4320 APA-5D',service,3,3,3, 'GROUND_POWER');
    put('Ladder',service,4,-5,1.25,'WORKSHOP_LADDER');
    put('Toolbox01',service,-4,-5,.75,'WORKSHOP_TOOLS');
    put(crew[0],service,-6,-5,.5,'WORKSHOP_TECH_1',true);
    put(crew[1],service,-6,-3,.5,'WORKSHOP_TECH_2',true);
    put('VP-FIRE_EX',service,-6,4,.5,'WORKSHOP_EXTINGUISHER',true);
    const stores=reserve(plan.stores);
    if(plan.stores==='ordnance') {
      put(plan.side==='blue'?'VPC-NATO-GBU-31 CART':'VP-BOGIE OFAB 120',stores,0,-4,3,'BOMB_CART',true);
      put('ammo_cargo',stores,3,3,1.25,'AMMO_BOXES');
      put('Cargo03',stores,-3,3,1.5,'AMMO_PALLET');
    } else {
      put('Cargo01',stores,3,3,1.5,'CARGO_CRATES_1');
      put('Cargo02',stores,-3,3,1.5,'CARGO_CRATES_2');
      put('B600',stores,0,-4,2,'CARGO_TUG');
    }
    put(crew[1],stores,-6,-4,.5,'STAGING_TECH',true);
    const logistics=reserve('logistics');
    put('Cargo01',logistics,4,4,1.5,'LOGISTICS_CRATES_1');
    put('Cargo02',logistics,0,4,1.5,'LOGISTICS_CRATES_2');
    put('Cargo03',logistics,-4,4,1.5,'LOGISTICS_PALLET');
    put('B600',logistics,4,-4,2,'LOGISTICS_TUG');
    put('Toolbox01',logistics,0,-4,.75,'LOGISTICS_TOOLS');
    put(crew[0],logistics,-4,-4,.5,'LOGISTICS_CREW_1',true);
    put(crew[1],logistics,-6,-4,.5,'LOGISTICS_CREW_2',true);
    put('VP-FIRE_EX',logistics,-6,0,.5,'LOGISTICS_EXTINGUISHER',true);
    manifest.push({airfield:plan.airfield,placed,zones,skipped:[...new Set(skipped)],
      notes:['Stand headings are a row-normal heuristic; taxi lanes/obstacles are not surveyed.','Bomb carts and personnel require the listed local scenery mods.']});
  }
  Object.assign(mission, copy);
  return manifest;
}
