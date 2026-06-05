import { z } from 'zod';

export const pathSuggestInputSchema = z.object({
  input: z.string(),
  limit: z.number().int().positive().max(100).optional(),
});

export const pathSuggestionSchema = z.object({
  path: z.string(),
  label: z.string(),
  kind: z.literal('directory'),
  hidden: z.boolean(),
});

export const pathSuggestOutputSchema = z.object({
  basePath: z.string(),
  input: z.string(),
  suggestions: z.array(pathSuggestionSchema),
});

export type PathSuggestInput = z.infer<typeof pathSuggestInputSchema>;
export type PathSuggestOutput = z.infer<typeof pathSuggestOutputSchema>;
export type PathSuggestion = z.infer<typeof pathSuggestionSchema>;
