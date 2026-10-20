import * as AnthropicLanguageModel from '@effect/ai-anthropic/AnthropicLanguageModel';
import { Effect, type JsonSchema, Stream } from 'effect';
import type { LanguageModel } from 'effect/ai';

/**
 * Wraps an `anthropic` model so every streamed generation asks the Messages API to constrain its
 * reply to `schema` (Core's `outputJsonSchema`). The Anthropic counterpart of `withStructuredOutput`,
 * kept apart because that file mirrors Fluidcast's backend. The adapter builds the request's
 * `output_config` from its own fields only, so the schema travels as the top-level `output_format`
 * the API still accepts. As there, the request config is merged per generation over any already in
 * context, and only `streamText` is constrained.
 */
export const withAnthropicStructuredOutput = (
  model: LanguageModel.LanguageModel,
  schema: JsonSchema.JsonSchema,
): LanguageModel.LanguageModel => {
  // A JSON Schema is JSON; the adapter types it as JSON values, which `JsonSchema` leaves `unknown`.
  const outputFormat = { type: 'json_schema', schema } as unknown as NonNullable<
    (typeof AnthropicLanguageModel.Config.Service)['output_format']
  >;
  const streamText = (options: Parameters<typeof model.streamText>[0]) =>
    Stream.unwrap(
      Effect.map(Effect.serviceOption(AnthropicLanguageModel.Config), (config) =>
        model.streamText(options).pipe(
          Stream.provideService(AnthropicLanguageModel.Config, {
            ...(config._tag === 'Some' ? config.value : {}),
            output_format: outputFormat,
          }),
        ),
      ),
    );
  // `streamText` is overloaded for toolkits, which Core never passes; this forwards every call.
  return { ...model, streamText: streamText as unknown as typeof model.streamText };
};
