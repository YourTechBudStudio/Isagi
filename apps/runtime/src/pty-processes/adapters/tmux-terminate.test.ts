import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { Effect, Either } from 'effect';

import { PtyKillError } from '../types.js';
import { TmuxBackend, TmuxBackendLive } from './tmux.js';

// tmux reports an already-gone session on stderr rather than through a
// distinguishable exit code, so these message shapes are the whole classifier.
// Getting them wrong in either direction is a correctness bug: treating a real
// control failure as absence would silently drop a live process, and treating
// absence as a kill would let a caller claim a termination that never happened.

const ref = { schemaVersion: 1, backend: 'tmux', sessionName: 'isagi_test_7' } as const;

async function killWithFakeTmux(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'isagi-tmux-terminate-'));
  const bin = join(root, 'bin');
  const previousPath = process.env.PATH;
  try {
    mkdirSync(bin);
    const tmuxPath = join(bin, 'tmux');
    writeFileSync(tmuxPath, script, 'utf8');
    chmodSync(tmuxPath, 0o755);
    process.env.PATH = previousPath ? `${bin}${delimiter}${previousPath}` : bin;
    return await Effect.runPromise(
      Effect.gen(function* () {
        const backend = yield* TmuxBackend;
        return yield* backend.kill(ref).pipe(Effect.either);
      }).pipe(Effect.provide(TmuxBackendLive)),
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeTmux(body: string) {
  return `#!/usr/bin/env node\n${body}\n`;
}

test('tmux kill affirms a termination when kill-session succeeds', async () => {
  const result = await killWithFakeTmux(fakeTmux('process.exit(0);'));

  assert.equal(Either.isRight(result), true);
  assert.deepEqual(Either.getOrThrow(result), { terminated: true });
});

test('tmux kill reports a missing session as absence, not as a kill', async () => {
  const result = await killWithFakeTmux(
    fakeTmux(`process.stderr.write("can't find session: isagi_test_7\\n");\nprocess.exit(1);`),
  );

  assert.equal(Either.isRight(result), true);
  assert.deepEqual(Either.getOrThrow(result), { terminated: false });
});

test('tmux kill reports a missing server as absence — the session cannot outlive it', async () => {
  const result = await killWithFakeTmux(
    fakeTmux(
      `process.stderr.write('no server running on /tmp/tmux-501/isagi\\n');\nprocess.exit(1);`,
    ),
  );

  assert.equal(Either.isRight(result), true);
  assert.deepEqual(Either.getOrThrow(result), { terminated: false });
});

test('tmux kill keeps an unrecognised failure a control failure with no terminal evidence', async () => {
  const result = await killWithFakeTmux(
    fakeTmux(`process.stderr.write('permission denied\\n');\nprocess.exit(1);`),
  );

  assert.equal(Either.isLeft(result), true);
  assert.ok(Either.isLeft(result) && result.left instanceof PtyKillError);
});

test('an unusable tmux binary is a control failure, never verified absence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-tmux-terminate-missing-'));
  const previousPath = process.env.PATH;
  try {
    // An empty PATH entry makes `tmux` unresolvable, which surfaces as ENOENT.
    process.env.PATH = join(root, 'bin');
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const backend = yield* TmuxBackend;
        return yield* backend.kill(ref).pipe(Effect.either);
      }).pipe(Effect.provide(TmuxBackendLive)),
    );

    assert.equal(Either.isLeft(result), true);
    assert.ok(Either.isLeft(result) && result.left instanceof PtyKillError);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
