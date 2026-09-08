import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { normalizeAbsoluteHomePath, normalizeHomePath } from './path.utils.js';

// Injecting a home is what makes tilde behavior testable without mutating
// `process.env` in a suite that runs with `--experimental-test-isolation=none`.
// That the implementation assigns no environment variable is established by
// inspection; no test here asserts it.
const injectedHome = mkdtempSync(join(tmpdir(), 'isagi-utils-home-'));
test.after(() => {
  rmSync(injectedHome, { recursive: true, force: true });
});

test('an injected home expands tilde input', () => {
  assert.equal(normalizeHomePath('~', injectedHome), injectedHome);
  assert.equal(normalizeHomePath('~/work', injectedHome), join(injectedHome, 'work'));
});

test('omitting the home argument preserves the existing runtime-home behavior', () => {
  assert.equal(normalizeHomePath('~'), homedir());
  assert.equal(normalizeHomePath('~/work'), join(homedir(), 'work'));
});

// This is the layer distinction: the utility's fallback is cwd-relative. Resolving
// ordinary relative *suggestion* input against the runtime home belongs to
// `parseInput` in path.suggestions.ts, not here.
test('non-tilde input keeps the cwd-relative fallback even when a home is injected', () => {
  assert.equal(normalizeHomePath('work/projects', injectedHome), resolve('work/projects'));
  assert.equal(normalizeHomePath('/srv/repos', injectedHome), resolve('/srv/repos'));
});

// `~name` is not shell-style user-home expansion here and must not become it.
test('an unsupported ~name spelling is not expanded to another user home', () => {
  assert.equal(normalizeHomePath('~someone/work', injectedHome), resolve('~someone/work'));
  assert.ok(!normalizeHomePath('~someone/work', injectedHome).startsWith(injectedHome));
});

test('absolute home normalization is unchanged by the optional parameter', () => {
  assert.equal(normalizeAbsoluteHomePath('~'), homedir());
  assert.equal(normalizeAbsoluteHomePath('/srv/repos/./nested'), '/srv/repos/nested');
  assert.throws(() => normalizeAbsoluteHomePath('   '));
  assert.throws(() => normalizeAbsoluteHomePath('relative/path'));
});
