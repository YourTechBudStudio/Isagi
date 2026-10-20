import * as AnthropicClient from '@effect/ai-anthropic/AnthropicClient';
import * as AnthropicLanguageModel from '@effect/ai-anthropic/AnthropicLanguageModel';
import * as CompatClient from '@effect/ai-openai-compat/OpenAiClient';
import * as CompatLanguageModel from '@effect/ai-openai-compat/OpenAiLanguageModel';
import * as OpenAiClient from '@effect/ai-openai/OpenAiClient';
import * as OpenAiLanguageModel from '@effect/ai-openai/OpenAiLanguageModel';
import { SpeechSynthesizer } from '@yourtechbudstudio/fluidcast-core/speech';
import * as OpenAiSpeech from '@yourtechbudstudio/fluidcast-core/speech/openai';
import { Context, Effect, Layer, type Scope } from 'effect';
import { LanguageModel } from 'effect/ai';
import { HttpClient, HttpClientRequest } from 'effect/http';

import type { FluidcastConfig } from '../runtime-config/index.js';

/** The configured models, built once and shared by every session: they are stateless clients. */
export interface FluidcastModels {
  /** The configured model, unwrapped. Progress uses it as is; the session factory derives the voice's model from it. */
  readonly languageModel: LanguageModel.LanguageModel;
  /**
   * The provider whose request shape constrains the voice to Fluidcast's output schema, or `null`
   * when replies are unconstrained: set only when the config's `structuredOutput` is true.
   */
  readonly structuredOutput: 'openai-compatible' | 'anthropic' | null;
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
        config.languageModel.provider !== 'openai' && config.languageModel.structuredOutput === true
          ? config.languageModel.provider
          : null,
      speech: Context.get(context, SpeechSynthesizer),
    };
  });

/**
 * OpenAI's Responses API, Chat Completions for a compatible server, or Anthropic's Messages API; no
 * ChatGPT or Claude sign-in.
 */
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
    case 'anthropic': {
      const betas = [
        ...(config.structuredOutput === true ? [structuredOutputsBeta] : []),
        ...(config.fast === true ? [fastModeBeta] : []),
      ];
      return AnthropicLanguageModel.layer({
        model: config.model,
        config: {
          ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
          ...(config.maxOutputTokens === undefined ? {} : { max_tokens: config.maxOutputTokens }),
          // The adapter's type predates xhigh and max; it sends the value through unchecked.
          ...(effort === undefined
            ? {}
            : { output_config: { effort: effort as 'low' | 'medium' | 'high' } }),
          ...(config.fast === true ? { speed: 'fast' as const } : {}),
          // Explicit: for a model ID it does not know, the adapter assumes structured outputs and
          // turns on strict tools and their beta. The voice asks for its schema per generation.
          structuredOutputs: config.structuredOutput === true,
        },
      }).pipe(
        Layer.provide(
          AnthropicClient.layer({
            apiKey: config.apiKey,
            ...apiUrl,
            ...(betas.length === 0 ? {} : { transformClient: withBetas(betas) }),
          }),
        ),
      );
    }
  }
}

/**
 * The legacy `output_format` field, which the voice's schema travels in, needs this beta. The
 * adapter sends it only for native tools, and Fluidcast's tools live in the prompt.
 */
const structuredOutputsBeta = 'structured-outputs-2025-11-13';
/** Fast mode is a research preview behind this beta, which the adapter does not send itself. */
const fastModeBeta = 'fast-mode-2026-02-01';

/** Adds each of `betas` to every request's `anthropic-beta` header, after any the adapter set. */
const withBetas = (betas: ReadonlyArray<string>) =>
  HttpClient.mapRequest((request) => {
    const existing = (request.headers['anthropic-beta'] ?? '').split(',').filter((b) => b !== '');
    const merged = [...existing, ...betas.filter((beta) => !existing.includes(beta))];
    return HttpClientRequest.setHeader(request, 'anthropic-beta', merged.join(','));
  });

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
