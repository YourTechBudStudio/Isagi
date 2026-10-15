import * as CompatClient from '@effect/ai-openai-compat/OpenAiClient';
import * as CompatLanguageModel from '@effect/ai-openai-compat/OpenAiLanguageModel';
import * as OpenAiClient from '@effect/ai-openai/OpenAiClient';
import * as OpenAiLanguageModel from '@effect/ai-openai/OpenAiLanguageModel';
import { SpeechSynthesizer } from '@yourtechbudstudio/fluidcast-core/speech';
import * as OpenAiSpeech from '@yourtechbudstudio/fluidcast-core/speech/openai';
import { Context, Effect, Layer, type Scope } from 'effect';
import { LanguageModel } from 'effect/ai';
import type { HttpClient } from 'effect/http';

import type { FluidcastConfig } from '../runtime-config/index.js';

/** The configured models, built once and shared by every session: they are stateless clients. */
export interface FluidcastModels {
  /** The configured model, unwrapped. Progress uses it as is; the session factory derives the voice's model from it. */
  readonly languageModel: LanguageModel.LanguageModel;
  /** True only for `openai-compatible` with `structuredOutput: true`. */
  readonly structuredOutput: boolean;
  readonly speech: SpeechSynthesizer['Service'];
}

/**
 * Builds the language model and speech clients from config in the caller's scope, over the given
 * `HttpClient`. Neither makes a request until a session generates or speaks. Keys stay `Redacted`
 * until the client layers.
 */
export const buildFluidcastModels = (
  config: FluidcastConfig,
): Effect.Effect<FluidcastModels, never, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.mergeAll(languageModelLayer(config.languageModel), speechLayer(config.speech)),
    );
    return {
      languageModel: Context.get(context, LanguageModel.LanguageModel),
      structuredOutput:
        config.languageModel.provider === 'openai-compatible' &&
        config.languageModel.structuredOutput === true,
      speech: Context.get(context, SpeechSynthesizer),
    };
  });

/** OpenAI's Responses API, or Chat Completions for a compatible server; no ChatGPT sign-in. */
function languageModelLayer(config: FluidcastConfig['languageModel']) {
  const sampling = {
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    // Both adapters take the Responses name; the compat one sends it as Chat Completions' `max_tokens`.
    ...(config.maxOutputTokens === undefined ? {} : { max_output_tokens: config.maxOutputTokens }),
  };
  const effort = config.reasoningEffort;
  const apiUrl = config.baseUrl === undefined ? {} : { apiUrl: config.baseUrl };
  switch (config.provider) {
    case 'openai':
      return OpenAiLanguageModel.layer({
        model: config.model,
        config: { ...sampling, ...(effort === undefined ? {} : { reasoning: { effort } }) },
      }).pipe(Layer.provide(OpenAiClient.layer({ apiKey: config.apiKey, ...apiUrl })));
    case 'openai-compatible':
      return CompatLanguageModel.layer({
        model: config.model,
        // Chat Completions' own field; the adapter passes unknown fields through to the request.
        config: { ...sampling, ...(effort === undefined ? {} : { reasoning_effort: effort }) },
      }).pipe(
        Layer.provide(
          CompatClient.layer({
            ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
            ...apiUrl,
          }),
        ),
      );
  }
}

/** Speech over its own client, provided locally so it never collides with the language model's. */
function speechLayer(config: FluidcastConfig['speech']) {
  return OpenAiSpeech.layer({ model: config.model }).pipe(
    Layer.provide(
      OpenAiClient.layer({
        apiKey: config.apiKey,
        ...(config.baseUrl === undefined ? {} : { apiUrl: config.baseUrl }),
      }),
    ),
  );
}
