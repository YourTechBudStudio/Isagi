// Copied from Fluidcast's reference backend (`apps/backend/src/conversation/structured-output.ts`),
// which Isagi must not import. Keep it in step with that file.
import * as CompatLanguageModel from '@effect/ai-openai-compat/OpenAiLanguageModel';
import { Effect, type JsonSchema, Stream } from 'effect';
import type { LanguageModel } from 'effect/ai';

/**
 * Wraps an `openai-compatible` model so every streamed generation asks the server to constrain its
 * reply to `schema` (Core's `outputJsonSchema`), as Chat Completions' strict `json_schema`
 * `response_format`. The request config is set per generation, merged over any already in context,
 * so the model layer keeps its own settings (temperature, reasoning effort) and other users of the
 * same model, such as the Forward tool's progress writer, still get plain text. Core only streams,
 * so only `streamText` is constrained.
 */
export const withStructuredOutput = (
  model: LanguageModel.LanguageModel,
  schema: JsonSchema.JsonSchema,
): LanguageModel.LanguageModel => {
  const responseFormat = {
    type: 'json_schema',
    json_schema: { name: 'actions', schema, strict: true },
  } as const;
  const streamText = (options: Parameters<typeof model.streamText>[0]) =>
    Stream.unwrap(
      Effect.map(Effect.serviceOption(CompatLanguageModel.Config), (config) =>
        model.streamText(options).pipe(
          Stream.provideService(CompatLanguageModel.Config, {
            ...(config._tag === 'Some' ? config.value : {}),
            response_format: responseFormat,
          }),
        ),
      ),
    );
  // `streamText` is overloaded for toolkits, which Core never passes; this forwards every call.
  return { ...model, streamText: streamText as unknown as typeof model.streamText };
};
