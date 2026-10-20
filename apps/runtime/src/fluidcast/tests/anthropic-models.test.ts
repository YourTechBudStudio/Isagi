import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, Redacted, Stream } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

import type { FluidcastConfig } from '../../runtime-config/index.js';
import { withAnthropicStructuredOutput } from '../anthropic-structured-output.js';
import { buildFluidcastModels } from '../models.js';
import { fluidcastConfig } from './support.js';

/** Records each Messages API request's body and headers, and answers with an empty stream. */
function recordingAnthropicClient() {
  const requests: Array<{
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Record<string, unknown>;
  }> = [];
  const client = HttpClient.make((request) => {
    if (request.body._tag === 'Uint8Array') {
      requests.push({
        url: request.url,
        headers: request.headers,
        body: JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>,
      });
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response('', { headers: { 'content-type': 'text/event-stream' } }),
      ),
    );
  });
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) };
}

function anthropicConfig(options: Partial<Record<string, unknown>> = {}): FluidcastConfig {
  return fluidcastConfig({
    provider: 'anthropic',
    model: 'claude-test',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: Redacted.make('sk-ant-test'),
    ...options,
  } as Partial<FluidcastConfig['languageModel']>);
}

/** Builds the models from `config` and streams one generation, through `wrap` when given. */
async function generate(
  config: FluidcastConfig,
  wrap?: (model: Parameters<typeof withAnthropicStructuredOutput>[0]) => typeof model,
) {
  const http = recordingAnthropicClient();
  const built = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const models = yield* buildFluidcastModels(config);
        const model = wrap === undefined ? models.languageModel : wrap(models.languageModel);
        yield* model.streamText({ prompt: 'hello' }).pipe(Stream.runDrain, Effect.ignore);
        return models;
      }),
    ).pipe(Effect.provide(http.layer)),
  );
  assert.equal(http.requests.length, 1);
  return { models: built, request: http.requests[0]! };
}

test('anthropic sends its key and sampling, with structured output and fast mode off by default', async () => {
  const { models, request } = await generate(
    anthropicConfig({ temperature: 0.5, maxOutputTokens: 900, reasoningEffort: 'xhigh' }),
  );
  assert.equal(models.structuredOutput, null);
  assert.ok(request.url.startsWith('http://127.0.0.1:9/v1/messages'));
  assert.equal(request.headers['x-api-key'], 'sk-ant-test');
  assert.equal(request.body.model, 'claude-test');
  assert.equal(request.body.temperature, 0.5);
  assert.equal(request.body.max_tokens, 900);
  assert.deepEqual(request.body.output_config, { effort: 'xhigh' });
  assert.equal(request.body.speed, undefined);
  assert.equal(request.body.output_format, undefined);
  assert.equal(request.body.structuredOutputs, undefined);
  assert.doesNotMatch(request.headers['anthropic-beta'] ?? '', /fast-mode|structured-outputs/);
});

test('fast mode sends the fast speed and its beta', async () => {
  const { request } = await generate(anthropicConfig({ fast: true }));
  assert.equal(request.body.speed, 'fast');
  assert.match(request.headers['anthropic-beta'] ?? '', /(^|,)fast-mode-2026-02-01$/);
});

test("structured output constrains the voice's requests to the schema, and only those", async () => {
  const config = anthropicConfig({ structuredOutput: true });
  const schema = { type: 'object', properties: { say: { type: 'string' } } } as const;
  const voice = await generate(config, (model) => withAnthropicStructuredOutput(model, schema));
  assert.equal(voice.models.structuredOutput, 'anthropic');
  assert.deepEqual(voice.request.body.output_format, { type: 'json_schema', schema });
  assert.equal(voice.request.headers['anthropic-beta'], 'structured-outputs-2025-11-13');

  const progress = await generate(config);
  assert.equal(progress.request.body.output_format, undefined);
});

test('structured output and fast mode send both betas in one header', async () => {
  const { request } = await generate(anthropicConfig({ structuredOutput: true, fast: true }));
  assert.equal(
    request.headers['anthropic-beta'],
    'structured-outputs-2025-11-13,fast-mode-2026-02-01',
  );
});
