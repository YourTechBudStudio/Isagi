import { Schema } from 'effect';

export const addProjectInputSchema = Schema.Struct({
  path: Schema.String.pipe(Schema.minLength(1)),
});

export type AddProjectInput = Schema.Schema.Type<typeof addProjectInputSchema>;
