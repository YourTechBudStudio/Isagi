import { Schema } from 'effect';

export const pathSuggestInputSchema = Schema.Struct({
  input: Schema.String,
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
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

export type PathSuggestInput = typeof pathSuggestInputSchema.Type;
export type PathSuggestOutput = typeof pathSuggestOutputSchema.Type;
export type PathSuggestion = typeof pathSuggestionSchema.Type;
