import { z } from 'zod';

/** Caller-supplied evidence, never a replacement for the bundled catalogue. */
export const aircraftCoverageProfileSchema = z.object({
  type: z.string().min(1),
  source: z.url().refine(s => /^https?:\/\//.test(s), 'Use an HTTP(S) evidence URL'),
  scope: z.string().min(1),
  fuelMaxKg: z.number().finite().positive().optional(),
  dimensionsMetres: z.object({
    width: z.number().finite().positive().optional(),
    length: z.number().finite().positive().optional(),
    height: z.number().finite().positive().optional(),
  }).strict().optional(),
}).strict();
export type AircraftCoverageProfile = z.infer<typeof aircraftCoverageProfileSchema>;
