import { Schema } from 'effect';

import { reconciliationFindingSchema } from '../workspace/types.js';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const projectRouteParamsSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
});

export const addProjectInputSchema = Schema.Struct({
  path: Schema.String.pipe(Schema.minLength(1)),
});

export const addProjectOutputSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
  alreadyExisted: Schema.Boolean,
});

export const relocateProjectInputSchema = Schema.Struct({
  path: Schema.String.pipe(Schema.minLength(1)),
});

export const relocateProjectOutputSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
  findings: Schema.Array(reconciliationFindingSchema),
});

export const deleteProjectOutputSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
  deleted: Schema.Boolean,
});

export type ProjectRouteParams = Schema.Schema.Type<typeof projectRouteParamsSchema>;
export type AddProjectInput = Schema.Schema.Type<typeof addProjectInputSchema>;
export type AddProjectOutput = Schema.Schema.Type<typeof addProjectOutputSchema>;
export type RelocateProjectInput = Schema.Schema.Type<typeof relocateProjectInputSchema>;
export type RelocateProjectOutput = Schema.Schema.Type<typeof relocateProjectOutputSchema>;
export type DeleteProjectOutput = Schema.Schema.Type<typeof deleteProjectOutputSchema>;
