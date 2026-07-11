import assert from 'node:assert/strict';
import test from 'node:test';

import { disabledHarnessPolicy, parseRuntimeConfig } from './runtime-config.policy.js';

test('harness policy distinguishes missing onboarding from an explicitly empty policy', () => {
  const missing = parseRuntimeConfig({ pty: { backend: 'node-pty' } }).harnesses;
  const empty = parseRuntimeConfig({ harnesses: {} }).harnesses;
  assert.equal(missing.status, 'missing');
  assert.equal(missing.onboardingComplete, false);
  assert.equal(empty.status, 'valid');
  assert.equal(empty.onboardingComplete, true);
  assert.notEqual(missing.revision, empty.revision);
  assert.deepEqual(empty.policy, disabledHarnessPolicy);
});
test('harness policy defaults partial fields false and ignores Docs intent for a disabled harness', () => {
  const state = parseRuntimeConfig({
    harnesses: { pi: { installIsagiDocs: true }, codex: { enabled: true } },
  }).harnesses;
  assert.deepEqual(state.policy.pi, { enabled: false, installIsagiDocs: false });
  assert.deepEqual(state.policy.codex, { enabled: true, installIsagiDocs: false });
});
test('invalid harness values fail closed without becoming onboarding defaults', () => {
  const state = parseRuntimeConfig({ harnesses: { pi: { enabled: 'yes' } } }).harnesses;
  assert.equal(state.status, 'invalid');
  assert.equal(state.onboardingComplete, false);
  assert.match(state.diagnostic ?? '', /boolean/i);
});
