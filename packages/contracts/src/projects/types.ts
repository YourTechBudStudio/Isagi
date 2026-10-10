import { Schema } from 'effect';

import { positiveInteger } from '../scalars.js';
import { reconciliationFindingSchema } from '../workspace/types.js';

export const projectRouteParamsSchema = Schema.Struct({
  projectId: positiveInteger,
});

export const addProjectInputSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)),
});

export const addProjectOutputSchema = Schema.Struct({
  projectId: positiveInteger,
  alreadyExisted: Schema.Boolean,
});

export const relocateProjectInputSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)),
});

export const relocateProjectOutputSchema = Schema.Struct({
  projectId: positiveInteger,
  findings: Schema.Array(reconciliationFindingSchema),
});

export const deleteProjectOutputSchema = Schema.Struct({
  projectId: positiveInteger,
  deleted: Schema.Boolean,
});

/**
 * One bounded move against an explicit sibling anchor. `null` appends to the
 * end of the present-project list; ranks are never exchanged over the wire.
 */
export const moveProjectOrderInputSchema = Schema.Struct({
  beforeProjectId: Schema.NullOr(positiveInteger),
});

export const moveProjectOrderOutputSchema = Schema.Struct({
  projectId: positiveInteger,
});

export type ProjectRouteParams = typeof projectRouteParamsSchema.Type;
export type AddProjectInput = typeof addProjectInputSchema.Type;
export type AddProjectOutput = typeof addProjectOutputSchema.Type;
export type RelocateProjectInput = typeof relocateProjectInputSchema.Type;
export type RelocateProjectOutput = typeof relocateProjectOutputSchema.Type;
export type DeleteProjectOutput = typeof deleteProjectOutputSchema.Type;
export type MoveProjectOrderInput = typeof moveProjectOrderInputSchema.Type;
export type MoveProjectOrderOutput = typeof moveProjectOrderOutputSchema.Type;
