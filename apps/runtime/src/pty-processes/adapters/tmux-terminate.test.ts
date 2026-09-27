import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { Effect, Either, Fiber } from 'effect';

import { PtyKillError } from '../types.js';
import { leakyRootScript, leakyTreeFixture, waitUntilGone } from './process-tree-test-support.js';
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

// `kill-session` only hangs up the pane processes. The fake below reports a real
// pane root and, like tmux, kills only that root — so the root's detached,
// signal-ignoring helper survives unless the adapter's process-tree sweep takes
// it. Its kill-session behaviour is chosen per test:
// - `exit`: kill the pane and succeed.
// - `linger`: kill the pane, write the marker, and answer a second later, the
//   way a server that has already acted can still be answering its client.
// - `hang`: kill the pane and never answer, so only the adapter's timeout ends it.
// - `refuse`: fail without touching the pane.
// - `vanished`: report the session missing without touching the pane, as when
//   the session ended between `list-panes` and `kill-session` but its pane root
//   ignored the hangup.
type FakePaneTmuxMode = 'exit' | 'linger' | 'hang' | 'refuse' | 'vanished';

const paneTmux = fakeTmux(`
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const pane = Number(process.env.ISAGI_FAKE_TMUX_PANE_PID);
const mode = process.env.ISAGI_FAKE_TMUX_MODE;
if (args.includes('list-panes')) {
  process.stdout.write(pane + '\\n');
  process.exit(0);
}
if (!args.includes('kill-session')) process.exit(0);
if (mode === 'vanished') {
  process.stderr.write("can't find session: isagi_test_7\\n");
  process.exit(1);
}
if (mode === 'refuse') {
  process.stderr.write('permission denied\\n');
  process.exit(1);
}
try { process.kill(pane, 'SIGHUP'); } catch {}
if (mode === 'linger') {
  writeFileSync(process.env.ISAGI_FAKE_TMUX_KILLED_MARKER, 'killed');
  setTimeout(() => process.exit(0), 1000);
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
`);

for (const operation of ['terminate', 'kill'] as const) {
  test(
    `tmux ${operation} sweeps a pane descendant that outlived kill-session`,
    { skip: process.platform === 'win32' },
    async () => {
      await withFakePaneTmux('exit', async ({ helperPid }) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* TmuxBackend;
            if (operation === 'kill') return yield* backend.kill(ref);
            assert.ok(backend.terminate);
            return yield* backend.terminate({ ref, gracefulTimeoutMs: 100 });
          }).pipe(Effect.provide(TmuxBackendLive)),
        );

        assert.deepEqual(result, { terminated: true });
        assert.equal(await waitUntilGone(helperPid), true);
      });
    },
  );
}

test(
  'cancelling a tmux kill after the server acted still sweeps the pane descendants',
  { skip: process.platform === 'win32' },
  async () => {
    await withFakePaneTmux('linger', async ({ helperPid, killedMarker }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* TmuxBackend;
          const fiber = yield* Effect.fork(backend.kill(ref));
          // Cancel only once the pane is really dead but the command is still
          // in flight — the window in which the sweep used to be skipped.
          yield* Effect.promise(() => waitForFile(killedMarker));
          yield* Fiber.interrupt(fiber);
        }).pipe(Effect.provide(TmuxBackendLive)),
      );

      assert.equal(await waitUntilGone(helperPid), true);
    });
  },
);

// A timeout is a control failure that says nothing about whether the server
// acted. Here it did: the pane is dead, so its descendants are swept even
// though the kill is still reported as a failure rather than affirmed. This
// waits out the adapter's real five-second kill timeout.
test(
  'a tmux kill that times out after the server acted still sweeps the pane descendants',
  { skip: process.platform === 'win32' },
  async () => {
    await withFakePaneTmux('hang', async ({ helperPid }) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* TmuxBackend;
          return yield* backend.kill(ref).pipe(Effect.either);
        }).pipe(Effect.provide(TmuxBackendLive)),
      );

      assert.ok(Either.isLeft(result) && result.left instanceof PtyKillError);
      assert.equal(await waitUntilGone(helperPid), true);
    });
  },
);

// The other side of that evidence: a failure that left the pane alive leaves a
// running process whose children are not the adapter's to take.
test(
  'a tmux kill that fails without acting leaves the live pane tree alone',
  { skip: process.platform === 'win32' },
  async () => {
    await withFakePaneTmux('refuse', async ({ helperPid, panePid }) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* TmuxBackend;
          return yield* backend.kill(ref).pipe(Effect.either);
        }).pipe(Effect.provide(TmuxBackendLive)),
      );

      assert.ok(Either.isLeft(result) && result.left instanceof PtyKillError);
      assert.equal(isAlive(panePid), true);
      assert.equal(isAlive(helperPid), true);
    });
  },
);

// Absence must stay honest: a session that is gone but whose pane root is still
// alive is not "nothing to kill". The sweep ends that root, and because this
// attempt did end a live process, it reports a termination rather than absence.
test(
  'a tmux kill that finds the session gone but its pane root alive kills it and affirms the kill',
  { skip: process.platform === 'win32' },
  async () => {
    await withFakePaneTmux('vanished', async ({ helperPid, panePid }) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* TmuxBackend;
          return yield* backend.kill(ref);
        }).pipe(Effect.provide(TmuxBackendLive)),
      );

      assert.deepEqual(result, { terminated: true });
      assert.equal(await waitUntilGone(panePid), true);
      assert.equal(await waitUntilGone(helperPid), true);
    });
  },
);

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withFakePaneTmux(
  mode: FakePaneTmuxMode,
  run: (fake: {
    readonly helperPid: number;
    readonly panePid: number;
    readonly killedMarker: string;
  }) => Promise<void>,
) {
  const fixture = leakyTreeFixture();
  const root = mkdtempSync(join(tmpdir(), 'isagi-tmux-tree-'));
  const bin = join(root, 'bin');
  const killedMarker = join(root, 'killed');
  const previousPath = process.env.PATH;
  // Detached, so the pane root leads its own session and group as a real tmux
  // pane process does.
  const pane = spawn(process.execPath, ['-e', leakyRootScript, fixture.pidFile], {
    detached: true,
    stdio: 'ignore',
  });
  try {
    mkdirSync(bin);
    writeFileSync(join(bin, 'tmux'), paneTmux, 'utf8');
    chmodSync(join(bin, 'tmux'), 0o755);
    process.env.PATH = previousPath ? `${bin}${delimiter}${previousPath}` : bin;
    process.env.ISAGI_FAKE_TMUX_PANE_PID = String(pane.pid);
    process.env.ISAGI_FAKE_TMUX_MODE = mode;
    process.env.ISAGI_FAKE_TMUX_KILLED_MARKER = killedMarker;
    await run({
      helperPid: await fixture.waitForHelperPid(),
      panePid: pane.pid ?? 0,
      killedMarker,
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    delete process.env.ISAGI_FAKE_TMUX_PANE_PID;
    delete process.env.ISAGI_FAKE_TMUX_MODE;
    delete process.env.ISAGI_FAKE_TMUX_KILLED_MARKER;
    pane.kill('SIGKILL');
    fixture.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`The fake tmux never wrote ${path}.`);
}
