import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Fiber, Layer, Queue, Stream } from 'effect';

import { ProcessTokens } from '../../access/index.js';
import { CliAccess } from '../../cli-access/index.js';
import { InternalEvents } from '../../platform/events/index.js';
import { DataDirectory, RuntimeDatabase } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { UserShell } from '../../platform/process/index.js';
import { PtyBackendCatalog } from '../backend.js';
import { PtyForegroundState } from '../foreground-state.js';
import { LaunchEnvironment } from '../launch-environment.js';
import { PtyRepository } from '../repository.js';
import { PtyService } from '../service.js';
import { fakeBackendCatalog } from '../testing.js';
import {
  PtyStartError,
  type PtyBackend as PtyBackendShape,
  type PtyProcessEvent,
} from '../types.js';

// Every path that ends a PTY after its launch environment issued a process token publishes one
// `pty_process_*` end event, and the access module's `ProcessTokens` releases the token on it. These
// tests run the real PTY service and the real `ProcessTokens` on one event bus, so each proves the
// whole chain for one end path.

/** CLI access that issues real tokens and adds nothing else. */
const tokenOnlyCliAccess = Layer.effect(
  CliAccess,
  Effect.gen(function* () {
    const tokens = yield* ProcessTokens;
    return CliAccess.of({
      publishRuntimeUrl: () => Effect.void,
      launchEnvironment: (_basePath, holder) =>
        Effect.map(tokens.issue(holder), (token) => ({ ISAGI_RUNTIME_TOKEN: token })),
    });
  }),
);

const userShell: UserShell['Service'] = {
  environment: { _tag: 'Available', values: { HOME: '/home/developer', PATH: '/usr/bin' } },
  run: () => Effect.die('not used'),
};

function backend(overrides: Partial<PtyBackendShape>): PtyBackendShape {
  return {
    name: 'node_pty',
    available: Effect.succeed(true),
    launch: (input) =>
      Effect.succeed({
        ref: { schemaVersion: 1, backend: 'node_pty', ptyProcessId: input.ptyProcessId, pid: 1234 },
        events: Stream.never,
      }),
    attach: () => Effect.die('not used'),
    writeInput: () => Effect.void,
    replay: () => Effect.void,
    inspect: () => Effect.succeed({ status: 'alive' }),
    listSessions: Effect.succeed([]),
    kill: () => Effect.succeed({ terminated: true }),
    ...overrides,
  };
}

const unusedTmux = backend({
  name: 'tmux',
  launch: () => Effect.die('tmux is not configured here'),
});

/** Runs `body` against the PTY service, the tokens and the repository over a fresh data root. */
function withPty(
  nodePty: PtyBackendShape,
  body: (
    dataRoot: string,
  ) => Effect.Effect<void, unknown, PtyService | ProcessTokens | PtyRepository>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-token-release-'));
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabase.layer.pipe(Layer.provide(directory));
  const repository = PtyRepository.layer.pipe(Layer.provide(database));
  const tokens = ProcessTokens.layerNoDeps;
  const service = PtyService.layerNoDeps.pipe(
    Layer.provide(LaunchEnvironment.layerNoDeps),
    Layer.provide(tokenOnlyCliAccess),
    Layer.provideMerge(tokens),
    Layer.provideMerge(repository),
    Layer.provide(
      Layer.succeed(
        PtyBackendCatalog,
        fakeBackendCatalog({ configured: 'node_pty', nodePty, tmux: unusedTmux }),
      ),
    ),
    Layer.provide(PtyForegroundState.layer),
    Layer.provide(directory),
    // One bus: the PTY service publishes on it and `ProcessTokens` subscribes to it.
    Layer.provide(InternalEvents.layer),
    Layer.provide(Layer.succeed(UserShell, userShell)),
  );
  return Effect.runPromise(Effect.scoped(body(dataRoot).pipe(Effect.provide(service)))).finally(
    () => rmSync(dataRoot, { recursive: true, force: true }),
  );
}

/** Waits until `condition` holds, or dies after `ms`: the release runs on the subscriber fiber. */
const eventually = (condition: () => boolean, ms = 2_000) =>
  Effect.gen(function* () {
    for (let waited = 0; !condition(); waited += 5) {
      if (waited >= ms) return yield* Effect.die(new Error('the token was never released'));
      yield* Effect.sleep('5 millis');
    }
  });

/** A backend that records each launch's token; its processes produce `events`. */
function recordingBackend() {
  const launched: string[] = [];
  return {
    launched,
    backend: (events: Stream.Stream<PtyProcessEvent> = Stream.never) =>
      backend({
        launch: (input) =>
          Effect.sync(() => {
            launched.push(input.env.ISAGI_RUNTIME_TOKEN ?? '');
            return {
              ref: {
                schemaVersion: 1,
                backend: 'node_pty',
                ptyProcessId: input.ptyProcessId,
                pid: 1234,
              } as const,
              events,
            };
          }),
      }),
  };
}

const launchInput = { command: 'bash', args: [], cwd: '/repo/isagi' } as const;

test('a PTY that exits releases its token', async () => {
  const exits = Effect.runSync(Queue.unbounded<PtyProcessEvent>());
  const recording = recordingBackend();
  await withPty(recording.backend(Stream.fromQueue(exits)), () =>
    Effect.gen(function* () {
      const pty = yield* PtyService;
      const tokens = yield* ProcessTokens;
      yield* pty.launch(launchInput);
      const [token] = recording.launched;
      assert.match(token ?? '', /^[0-9a-f]{64}$/, 'the launch environment carries a token');
      assert.equal(tokens.isLive(token!), true, 'live while the process runs');

      yield* Queue.offer(exits, { _tag: 'Exited', exitCode: 0, signal: null });
      yield* eventually(() => !tokens.isLive(token!));
    }),
  );
});

test('a killed PTY releases its token', async () => {
  const recording = recordingBackend();
  await withPty(recording.backend(), () =>
    Effect.gen(function* () {
      const pty = yield* PtyService;
      const tokens = yield* ProcessTokens;
      const { ptyProcessId } = yield* pty.launch(launchInput);
      const [token] = recording.launched;
      assert.equal(tokens.isLive(token!), true);

      yield* pty.terminate({ ptyProcessId, gracefulTimeoutMs: 10 });
      yield* eventually(() => !tokens.isLive(token!));
    }),
  );
});

test('a PTY whose spawn fails releases its token', async () => {
  let issued: string | undefined;
  await withPty(
    backend({
      launch: (input) =>
        Effect.suspend(() => {
          issued = input.env.ISAGI_RUNTIME_TOKEN;
          return Effect.fail(
            new PtyStartError({
              ptyProcessId: input.ptyProcessId,
              command: input.command,
              cwd: input.cwd,
              cause: new Error('spawn refused'),
            }),
          );
        }),
    }),
    () =>
      Effect.gen(function* () {
        const pty = yield* PtyService;
        const tokens = yield* ProcessTokens;
        const { ptyProcessId } = yield* pty.launch(launchInput);
        assert.ok(issued !== undefined, 'the spawn was given a token');
        assert.equal((yield* (yield* PtyRepository).findProcess(ptyProcessId))?.status, 'failed');
        yield* eventually(() => !tokens.isLive(issued!));
      }),
  );
});

test('a PTY whose preparation fails after its token was issued releases it', async () => {
  await withPty(
    backend({ launch: () => Effect.die('preparation fails before any spawn') }),
    (dataRoot) =>
      Effect.gen(function* () {
        const pty = yield* PtyService;
        const tokens = yield* ProcessTokens;
        let token: string | undefined;
        // A removed sessions directory: the log cannot be created after the environment (and
        // its token) was resolved, which is an expected pre-spawn failure.
        rmSync(join(dataRoot, 'sessions'), { recursive: true, force: true });
        const { ptyProcessId } = yield* pty.launch({
          ...launchInput,
          // Runs after the launch environment; `issue` is idempotent per holder, so this reads
          // the token the environment carries.
          envForProcess: (process) =>
            Effect.map(tokens.issue({ _tag: 'pty', ptyProcessId: process.ptyProcessId }), (t) => {
              token = t;
              return {};
            }),
        });
        assert.equal((yield* (yield* PtyRepository).findProcess(ptyProcessId))?.status, 'failed');
        assert.ok(token !== undefined);
        yield* eventually(() => !tokens.isLive(token!));
      }),
  );
});

test('a PTY launch cancelled during preparation releases its token', async () => {
  await withPty(backend({}), () =>
    Effect.gen(function* () {
      const pty = yield* PtyService;
      const tokens = yield* ProcessTokens;
      let token: string | undefined;
      // `envForProcess` runs after the launch environment issued the token; it blocks, so the
      // launch can be interrupted inside preparation.
      const launching = yield* Effect.forkChild(
        pty.launch({
          ...launchInput,
          envForProcess: (process) =>
            Effect.gen(function* () {
              token = yield* tokens.issue({ _tag: 'pty', ptyProcessId: process.ptyProcessId });
              return yield* Effect.never;
            }),
        }),
      );
      yield* eventually(() => token !== undefined);
      assert.equal(tokens.isLive(token!), true);
      yield* Fiber.interrupt(launching);
      yield* eventually(() => !tokens.isLive(token!));
    }),
  );
});
