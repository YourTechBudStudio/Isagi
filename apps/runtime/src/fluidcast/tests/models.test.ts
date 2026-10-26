import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Redacted, Stream } from 'effect';
import type { LanguageModel } from 'effect/ai';

import type { FluidcastConfig } from '../../runtime-config/index.js';
import { buildFluidcastModels, type FluidcastModels } from '../models.js';
import { fluidcastConfig, recordingHttpClient } from './support.js';

const schema = { type: 'object', properties: { say: { type: 'string' } } } as const;

/** Builds the models from `config`, then streams one generation from each role `pick` returns. */
async function generateEach(
  config: FluidcastConfig,
  pick: (models: FluidcastModels) => ReadonlyArray<LanguageModel.LanguageModel>,
) {
  const http = recordingHttpClient();
  const models = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const built = yield* buildFluidcastModels(config);
        for (const model of pick(built)) {
          yield* model.streamText({ prompt: 'hello' }).pipe(Stream.runDrain, Effect.ignore);
        }
        return built;
      }),
    ).pipe(Effect.provide(http.layer)),
  );
  return { models, bodies: http.bodies };
}

test('without a summary model, the summary role is the unwrapped voice model', async () => {
  const { models, bodies } = await generateEach(
    fluidcastConfig({ structuredOutput: true }),
    (m) => [m.voice(schema), m.base, m.summary],
  );
  assert.equal(models.summary, models.base);
  assert.equal(bodies.length, 3);
  assert.equal((bodies[0]!.response_format as { type: string }).type, 'json_schema');
  assert.equal(bodies[1]!.response_format, undefined);
  assert.equal(bodies[2]!.response_format, undefined);
});

test('an unstructured voice is the base model itself', async () => {
  const { models } = await generateEach(fluidcastConfig(), () => []);
  assert.equal(models.voice(schema), models.base);
});

test('a summary model is its own plain connection beside a structured voice', async () => {
  const config: FluidcastConfig = {
    ...fluidcastConfig({ structuredOutput: true }),
    summaryModel: {
      provider: 'openai-compatible',
      model: 'summary-model',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: Redacted.make('sk-summary'),
      temperature: 0.2,
    },
  };
  const { models, bodies } = await generateEach(config, (m) => [m.voice(schema), m.summary]);
  assert.notEqual(models.summary, models.base);
  assert.equal(bodies[0]!.model, 'test-model');
  assert.equal((bodies[0]!.response_format as { type: string }).type, 'json_schema');
  assert.equal(bodies[1]!.model, 'summary-model');
  assert.equal(bodies[1]!.temperature, 0.2);
  assert.equal(bodies[1]!.response_format, undefined);
});
