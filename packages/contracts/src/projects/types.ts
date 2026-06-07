import { Schema } from 'effect';

export const addProjectInputSchema = Schema.Struct({
  path: Schema.String.pipe(Schema.minLength(1)),
});

export const addProjectOutputSchema = Schema.Struct({
  projectId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  alreadyExisted: Schema.Boolean,
});

export type AddProjectInput = Schema.Schema.Type<typeof addProjectInputSchema>;
export type AddProjectOutput = Schema.Schema.Type<typeof addProjectOutputSchema>;
