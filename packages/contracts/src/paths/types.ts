import { Schema } from 'effect';

export const pathSuggestInputSchema = Schema.Struct({
  input: Schema.String,
  limit: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.positive(), Schema.lessThanOrEqualTo(100)),
  ),
});

export const pathSuggestionSchema = Schema.Struct({
  path: Schema.String,
  label: Schema.String,
  kind: Schema.Literal('directory'),
  hidden: Schema.Boolean,
});

export const pathSuggestOutputSchema = Schema.Struct({
  basePath: Schema.String,
  input: Schema.String,
  suggestions: Schema.Array(pathSuggestionSchema),
});

export type PathSuggestInput = Schema.Schema.Type<typeof pathSuggestInputSchema>;
export type PathSuggestOutput = Schema.Schema.Type<typeof pathSuggestOutputSchema>;
export type PathSuggestion = Schema.Schema.Type<typeof pathSuggestionSchema>;
