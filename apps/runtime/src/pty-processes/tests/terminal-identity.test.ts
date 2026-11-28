import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { CliAccessNone } from '../../cli-access/testing.js';
import { publishOnlyRecordingEventBus } from '../../platform/events/testing.js';
import { DataDirectory, RuntimeDatabase } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { testUserShellLayer } from '../../platform/process/testing.js';
import { NodePtyBackend } from '../adapters/node-pty.js';
import { PtyBackendCatalog } from '../backend.js';
import { PtyForegroundState } from '../foreground-state.js';
import { LaunchEnvironment } from '../launch-environment.js';
import { PtyRepository } from '../repository.js';
import { PtyService } from '../service.js';
import { fakeBackendCatalog, ptyTestRuntimeConfig } from '../testing.js';

// What a TUI inside a real node-pty PTY sees about its terminal. The environment the runtime was launched with names
// another terminal and multiplexer; the PTY must carry none of that, and must declare an SSH-style session so Codex
// copies via OSC 52 to the user's own clipboard.

const launchingTerminalEnvironment = {
  HOME: process.env.HOME ?? '/tmp',
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  TMUX: '/tmp/tmux-501/default,123,0',
  TERM_PROGRAM: 'iTerm.app',
  VTE_VERSION: '7600',
};

function serviceLayer(dataRoot: string) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabase.layer.pipe(Layer.provide(directory));
  const repository = PtyRepository.layer.pipe(Layer.provide(database));
  const userShell = testUserShellLayer({ environment: launchingTerminalEnvironment });
  const catalog = Layer.effect(
    PtyBackendCatalog,
    Effect.gen(function* () {
      const nodePty = yield* NodePtyBackend;
      return fakeBackendCatalog({ nodePty });
    }),
  ).pipe(Layer.provide(NodePtyBackend.layer));
  const service = PtyService.layerNoDeps.pipe(
    Layer.provide([
      catalog,
      LaunchEnvironment.layerNoDeps.pipe(Layer.provide([CliAccessNone, userShell])),
      PtyForegroundState.layer,
      ptyTestRuntimeConfig(),
      publishOnlyRecordingEventBus('the PTY service does not subscribe').layer,
      userShell,
      repository,
      directory,
    ]),
  );
  return Layer.mergeAll(database, repository, service);
}

const waitForFile = (path: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 5_000;
    while (!existsSync(path)) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`${path} never appeared`));
      yield* Effect.sleep('10 millis');
    }
  });

function parseEnv(output: string) {
  return new Map(
    output
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

test('a real node-pty PTY declares an SSH-style Isagi terminal and hides the launching terminal', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-terminal-identity-'));
  const envFile = join(dataRoot, 'pty-env.txt');
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const pty = yield* PtyService;
        // `env` runs inside the PTY; the rename makes the file appear only once it is complete.
        yield* pty.launch({
          command: '/bin/sh',
          args: ['-c', 'env > "$1.partial" && mv "$1.partial" "$1"', 'sh', envFile],
          cwd: dataRoot,
        });
        yield* waitForFile(envFile);
      }).pipe(Effect.scoped, Effect.provide(serviceLayer(dataRoot))),
    );

    const seen = parseEnv(readFileSync(envFile, 'utf8'));
    assert.equal(seen.get('SSH_TTY'), '/dev/tty');
    assert.equal(seen.get('SSH_CONNECTION'), undefined);
    assert.equal(seen.get('TERM'), 'xterm-256color');
    assert.equal(seen.get('COLORTERM'), 'truecolor');
    assert.equal(seen.get('TMUX'), undefined);
    assert.equal(seen.get('TERM_PROGRAM'), undefined);
    assert.equal(seen.get('VTE_VERSION'), undefined);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
