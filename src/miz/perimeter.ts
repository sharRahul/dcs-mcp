/** Static scenery boundaries. Nominal dimensions are layout inputs, not mesh measurements. */
import { z } from 'zod';
import { addStatic } from './editing.js';
import { findUnitType } from '../data/reference.js';
import type { Side } from './authoring.js';
import type { LuaTable } from './lua.js';

export const gateSchema = z.object({ edge:z.enum(['front','rear','left','right']),
 offsetMetres:z.number().finite().default(0), widthMetres:z.number().min(3).max(100).default(12),
}).strict();
export const perimeterSpecSchema = z.object({
 type:z.string().min(1).max(120).default('Twall_x1'),
 segmentLengthMetres:z.number().min(1).max(50).default(3),
 segmentDepthMetres:z.number().positive().max(20).default(.4),
 modelHeadingOffsetDegrees:z.number().min(-180).max(180).default(0),
 gates:z.array(gateSchema).max(8).default([{edge:'front',offsetMetres:0,widthMetres:12}]),
 approachLengthMetres:z.number().min(1).max(100).default(20),
 paddingMetres:z.number().min(25).max(200).default(50),
}).strict();
export type PerimeterSpec = z.input<typeof perimeterSpecSchema>;
export interface RectanglePerimeterArgs extends PerimeterSpec {
 side:Side;country:string;countryId?:number;name:string;x:number;y:number;heading?:number;
 widthMetres:number;depthMetres:number;dead?:boolean;
}
type Point={x:number;y:number};
export interface PerimeterResult {
 objects:string[];
 segments:{name:string;edge:string;localOffsetMetres:number;spanMetres:number;x:number;y:number;headingDegrees:number}[];
 entrances:{edge:string;offsetMetres:number;widthMetres:number;x:number;y:number;approach:{inside:Point;outside:Point}}[];
 widthMetres:number;depthMetres:number;dimensionsVerified:false;notes:string[];
}
export function addRectanglePerimeter(mission:LuaTable,args:RectanglePerimeterArgs):PerimeterResult {
 const {side,country,countryId,name,x,y,heading=0,widthMetres:w,depthMetres:d,dead,...input}=args;
 const spec=perimeterSpecSchema.parse(input);
 if(![x,y,heading,w,d].every(Number.isFinite)||w<20||d<20||w>2000||d>2000)throw new Error('Perimeter needs finite position/heading and width/depth 20..2000 metres');
 if(!name.length||name.length>64)throw new Error('Perimeter name must be 1..64 characters');
 const type=findUnitType(spec.type);
 if(type?.category!=='static'||(type.entry as {category:string}).category!=='Fortifications')throw new Error('Perimeter type must be a known Fortifications static');
 const h=heading*Math.PI/180;
 const world=(forward:number,right:number):Point=>({x:x+forward*Math.cos(h)-right*Math.sin(h),y:y+forward*Math.sin(h)+right*Math.cos(h)});
 const result:PerimeterResult={objects:[],segments:[],entrances:[],widthMetres:w,depthMetres:d,dimensionsVerified:false,
  notes:['Nominal segment dimensions and heading alignment are layout assumptions; no collision meshes were measured.',
   'Small seams between full-size segments may remain; objects are not scaled.',
   'Entrance approaches are geometry metadata, not authored roads or a guarantee of AI vehicle access. Check terrain, buildings and model fit in DCS.']};
 for(const edge of ['front','rear','left','right'] as const){
  const horizontal=edge==='front'||edge==='rear', length=horizontal?w:d;
  const gates=spec.gates.filter(g=>g.edge===edge).sort((a,b)=>a.offsetMetres-b.offsetMetres);
  let cursor=-length/2;
  const runs:{start:number;end:number}[]=[];
  for(const gate of gates){
   const start=gate.offsetMetres-gate.widthMetres/2,end=gate.offsetMetres+gate.widthMetres/2;
   if(start < -length/2+spec.segmentDepthMetres/2 || end>length/2-spec.segmentDepthMetres/2)throw new Error('Entrance extends beyond edge or into a corner');
   if(start<cursor)throw new Error('Entrances overlap');
   runs.push({start:cursor,end:start});cursor=end;
   const f=horizontal?(edge==='front'?d/2:-d/2):gate.offsetMetres;
   const r=horizontal?gate.offsetMetres:(edge==='right'?w/2:-w/2);
   const normalF=horizontal?(edge==='front'?1:-1):0,normalR=horizontal?0:(edge==='right'?1:-1);
   const inward=Math.min(spec.approachLengthMetres,(horizontal?d:w)/2);
   result.entrances.push({edge,offsetMetres:gate.offsetMetres,widthMetres:gate.widthMetres,...world(f,r),
    approach:{inside:world(f-normalF*inward,r-normalR*inward),outside:world(f+normalF*spec.approachLengthMetres,r+normalR*spec.approachLengthMetres)}});
  }
  runs.push({start:cursor,end:length/2});
  for(const run of runs){
   const usable=run.end-run.start,n=Math.floor((usable+1e-9)/spec.segmentLengthMetres);
   if(n===0 && usable>1e-8)throw new Error('Wall run too short for selected segment; adjust entrance or segment size');
   if(result.segments.length+n>1000)throw new Error('Perimeter exceeds 1000 static objects');
    const step=n>1?(usable-spec.segmentLengthMetres)/(n-1):0;
    const seam=n>1?step-spec.segmentLengthMetres:(usable-spec.segmentLengthMetres)/2;
    if(seam>.5+1e-9)throw new Error('Wall layout would leave gaps over 0.5 m; choose shorter segments or adjust dimensions/entrances');
   for(let i=0;i<n;i++){
    const p=n===1?(run.start+run.end)/2:run.start+spec.segmentLengthMetres/2+i*step;
    const f=horizontal?(edge==='front'?d/2:-d/2):p,r=horizontal?p:(edge==='right'?w/2:-w/2);
    const namePart=`${name}-${result.segments.length+1}`;
    const headingDegrees=((heading+(horizontal?90:0)+spec.modelHeadingOffsetDegrees)%360+360)%360;
    result.objects.push(namePart);result.segments.push({name:namePart,edge,localOffsetMetres:p,spanMetres:spec.segmentLengthMetres,...world(f,r),headingDegrees});
   }
  }
 }
 const copy=structuredClone(mission);
 for(const s of result.segments)addStatic(copy,{side,country,countryId,name:s.name,type:spec.type,x:s.x,y:s.y,heading:s.headingDegrees,dead});
 Object.assign(mission,copy);
 return result;
}
