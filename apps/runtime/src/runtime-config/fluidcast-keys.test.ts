import assert from 'node:assert/strict';
import test from 'node:test';

import { Redacted } from 'effect';

import { resolveFluidcastKeys } from './fluidcast-keys.js';
import type { FluidcastConfig } from './policy.js';

const sentinel = 'sk-isagi-SENTINEL-keys-91c2';

function config(languageModelKey: string | undefined, speechKey: string): FluidcastConfig {
  return {
    enabled: true,
    languageModel: {
      provider: 'openai-compatible',
      model: 'local',
      ...(languageModelKey === undefined ? {} : { apiKey: Redacted.make(languageModelKey) }),
    },
    speech: { model: 'tts-test', apiKey: Redacted.make(speechKey), format: 'opus' },
    preset: { profile: 'detailed', voice: { name: 'alloy' } },
  };
}

test('env keys take their variable value and literal keys stay as written', () => {
  const resolved = resolveFluidcastKeys(config('env.LM_KEY', 'sk-literal'), { LM_KEY: sentinel });
  assert.ok(resolved.status === 'resolved');
  assert.equal(Redacted.value(resolved.config.languageModel.apiKey!), sentinel);
  assert.equal(Redacted.value(resolved.config.speech.apiKey), 'sk-literal');
  assert.equal(String(resolved.config.languageModel.apiKey), '<redacted>');
});

test('an absent language-model key stays absent', () => {
  const resolved = resolveFluidcastKeys(config(undefined, 'env.SPEECH_KEY'), {
    SPEECH_KEY: sentinel,
  });
  assert.ok(resolved.status === 'resolved');
  assert.equal(resolved.config.languageModel.apiKey, undefined);
  assert.equal(Redacted.value(resolved.config.speech.apiKey), sentinel);
});

test('unset and empty variables are reported by path and name, never by value', () => {
  const resolved = resolveFluidcastKeys(config('env.LM_KEY', 'env.SPEECH_KEY'), {
    SPEECH_KEY: '',
    OTHER: sentinel,
  });
  assert.deepEqual(resolved, {
    status: 'unset',
    unset: [
      { issuePath: 'fluidcast.languageModel.apiKey', variable: 'LM_KEY' },
      { issuePath: 'fluidcast.speech.apiKey', variable: 'SPEECH_KEY' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(resolved), new RegExp(sentinel));
});

test("the summary model's env key resolves, and its unset variable is reported by its path", () => {
  const withSummary = (summaryKey: string): FluidcastConfig => ({
    ...config('sk-literal', 'sk-literal'),
    summaryModel: { provider: 'anthropic', model: 'haiku', apiKey: Redacted.make(summaryKey) },
  });
  const resolved = resolveFluidcastKeys(withSummary('env.SUMMARY_KEY'), { SUMMARY_KEY: sentinel });
  assert.ok(resolved.status === 'resolved');
  assert.equal(Redacted.value(resolved.config.summaryModel!.apiKey!), sentinel);
  assert.equal(Redacted.value(resolved.config.languageModel.apiKey!), 'sk-literal');

  assert.deepEqual(resolveFluidcastKeys(withSummary('env.SUMMARY_KEY'), {}), {
    status: 'unset',
    unset: [{ issuePath: 'fluidcast.summaryModel.apiKey', variable: 'SUMMARY_KEY' }],
  });
});

test("an openai-compatible summary model's absent key stays absent", () => {
  const resolved = resolveFluidcastKeys(
    {
      ...config(undefined, 'sk-literal'),
      summaryModel: { provider: 'openai-compatible', model: 'small' },
    },
    {},
  );
  assert.ok(resolved.status === 'resolved');
  assert.equal(resolved.config.summaryModel?.apiKey, undefined);
  assert.equal(resolved.config.summaryModel?.model, 'small');
});
