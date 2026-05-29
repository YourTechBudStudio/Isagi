import { oc } from '@orpc/contract';
import { z } from 'zod';

export const healthOutputSchema = z.object({
  context: z.object({
    arch: z.string(),
    node: z.string(),
    pid: z.number().int().positive(),
    platform: z.string(),
  }),
  name: z.literal('isagi-runtime'),
  ok: z.literal(true),
  timestamp: z.string(),
  version: z.string(),
});

export const contract = {
  health: oc.output(healthOutputSchema),
};

export type IsagiContract = typeof contract;
export type HealthOutput = z.infer<typeof healthOutputSchema>;
