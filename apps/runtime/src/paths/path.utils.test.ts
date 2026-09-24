import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  canonicalizeProspectivePath,
  normalizeAbsoluteHomePath,
  normalizeHomePath,
} from './path.utils.js';

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

test('a path that does not exist yet keeps its missing segments under its resolved ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-canonical-'));
  try {
    const real = join(root, 'real');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link'));
    // The symlinked parent resolves even though the leaf is still to be created, which is the
    // macOS `/tmp` → `/private/tmp` case in miniature.
    assert.equal(
      canonicalizeProspectivePath(join(root, 'link', 'a', 'b')),
      join(realpathSync.native(real), 'a', 'b'),
    );
    assert.equal(canonicalizeProspectivePath(join(root, 'link')), realpathSync.native(real));
    assert.equal(
      canonicalizeProspectivePath(join(root, 'link', '..', 'x')),
      join(realpathSync.native(root), 'x'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing ancestor is spelled in the letter case stored on disk', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-canonical-case-'));
  try {
    const onDisk = join(root, 'CaseProbe');
    mkdirSync(onDisk);
    const typed = join(root, 'caseprobe');
    if (!existsSync(typed)) {
      t.skip('the temporary filesystem is case-sensitive');
      return;
    }
    assert.equal(
      canonicalizeProspectivePath(join(typed, 'new')),
      join(realpathSync.native(onDisk), 'new'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failure other than "not found" is thrown rather than walked past', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root ignores directory permissions');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'isagi-canonical-denied-'));
  const locked = join(root, 'locked');
  mkdirSync(join(locked, 'inside'), { recursive: true });
  chmodSync(locked, 0o000);
  try {
    assert.throws(
      () => canonicalizeProspectivePath(join(locked, 'inside', 'new')),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES',
    );
  } finally {
    chmodSync(locked, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
