import {z} from 'zod';
const name=z.string().min(1).max(200);
export const criterionSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('group_exists'),group:name}).strict(),
 z.object({kind:z.literal('group_alive'),group:name}).strict(),
 z.object({kind:z.literal('group_on_ground'),group:name}).strict(),
 z.object({kind:z.literal('flag_equals'),flag:z.union([z.string().min(1).max(64),z.number().int().positive().max(2147483647)]),value:z.number().finite()}).strict(),
 z.object({kind:z.literal('event'),event:z.string().regex(/^S_EVENT_[A-Z_]+$/),initiator:name.optional(),place:name.optional()}).strict(),
 z.object({kind:z.literal('scenario_outcome'),value:z.enum(['victory','failure'])}).strict(),
 z.object({kind:z.literal('log_clean')}).strict(),z.object({kind:z.literal('manual')}).strict(),
]);
export const productionPlanSchema=z.object({name:z.string().min(1).max(100),theatre:name,objective:z.string().min(1).max(10000),
 assumptions:z.array(z.string().min(1).max(2000)).max(100).default([]),
 checks:z.array(z.object({id:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),description:z.string().min(1).max(2000),criterion:criterionSchema}).strict()).min(1).max(100),
}).strict().refine(p=>new Set(p.checks.map(c=>c.id)).size===p.checks.length,'Check ids must be unique');
export type ProductionPlan=z.infer<typeof productionPlanSchema>;
export const projectSchema=z.object({version:z.literal(1),id:z.string().uuid(),createdAt:z.string().datetime(),plan:productionPlanSchema}).strict();
export const revisionSchema=z.object({version:z.literal(1),projectId:z.string().uuid(),id:z.string().uuid(),number:z.number().int().min(1).max(9999),
 planDigest:z.string().regex(/^[a-f0-9]{64}$/),outcomeFlag:z.number().int().positive().optional(),createdAt:z.string().datetime(),notes:z.string().min(1).max(10000),digest:z.string().regex(/^[a-f0-9]{64}$/),logMarker:z.string().min(1),
}).strict();
export type Revision=z.infer<typeof revisionSchema>;
