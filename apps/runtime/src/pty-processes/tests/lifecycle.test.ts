import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  type Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Ref,
  Result,
  Scope,
  Stream,
} from 'effect';
import { TestClock } from 'effect/testing';

import type { PtyStreamOutputMessageSet } from '@isagi/contracts';

import { expectNoProcessMatching } from '../../../test/test-support.js';
import { CliAccessNone } from '../../cli-access/testing.js';
import { publishOnlyRecordingEventBus } from '../../platform/events/testing.js';
import { DatabaseError, DataDirectory, RuntimeDatabase } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { UserShell } from '../../platform/process/index.js';
import { NodePtyBackend } from '../adapters/node-pty.js';
import { PtyBackendCatalog } from '../backend.js';
import { PtyForegroundState } from '../foreground-state.js';
import { LaunchEnvironment } from '../launch-environment.js';
import { PtyRepository } from '../repository.js';
import { PtyService, SHUTDOWN_GRACEFUL_TIMEOUT_MS } from '../service.js';
import { fakeBackendCatalog } from '../testing.js';
import {
  PtyServiceError,
  PtyStartError,
  type PtyBackend as PtyBackendShape,
  type PtyOutputMessage,
  type PtyProcessEvent,
} from '../types.js';

const runWithTestClock = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);

// The PTY service owns long-lived work: one supervisor fiber per process, an
// attachment's forwarders, two periodic loops, and the persistence retry. These
// tests close the service scope and assert what that scope guarantees.

function testUserShell(): UserShell['Service'] {
  return {
    environment: {
      _tag: 'Available' as const,
      values: { HOME: process.env.HOME ?? '/tmp', PATH: process.env.PATH ?? '/usr/bin:/bin' },
    },
    run: () => Effect.die('PTY lifecycle tests do not run user-shell commands.'),
  };
}

function unavailableTmux(): PtyBackendShape {
  return {
    name: 'tmux',
    available: Effect.succeed(false),
    launch: () => Effect.die('tmux launch is not expected in these tests'),
    writeInput: () => Effect.die('tmux writeInput is not expected in these tests'),
    attach: () => Effect.die('tmux attach is not expected in these tests'),
    replay: () => Effect.die('tmux replay is not expected in these tests'),
    inspect: () => Effect.die('tmux inspect is not expected in these tests'),
    listSessions: Effect.die('tmux listSessions is not expected in these tests'),
    kill: () => Effect.die('tmux kill is not expected in these tests'),
  };
}

function fakeNodePty(overrides: Partial<PtyBackendShape> = {}): PtyBackendShape {
  return {
    name: 'node_pty',
    available: Effect.succeed(true),
    launch: (input) =>
      Effect.succeed({
        ref: {
          schemaVersion: 1,
          backend: 'node_pty',
          ptyProcessId: input.ptyProcessId,
          pid: 4_242,
        },
        events: Stream.empty,
      }),
    writeInput: () => Effect.void,
    attach: () => Effect.die('attach is not expected here'),
    replay: () => Effect.void,
    inspect: () => Effect.succeed({ status: 'alive' as const }),
    listSessions: Effect.succeed([]),
    kill: () => Effect.succeed({ terminated: true }),
    ...overrides,
  };
}

const realNodePtyCatalog = Layer.effect(
  PtyBackendCatalog,
  Effect.gen(function* () {
    const nodePty = yield* NodePtyBackend;
    return fakeBackendCatalog({ configured: 'node_pty', nodePty, tmux: unavailableTmux() });
  }),
).pipe(Layer.provide(NodePtyBackend.layer));

function fakeCatalog(nodePty: PtyBackendShape) {
  return Layer.succeed(
    PtyBackendCatalog,
    fakeBackendCatalog({ configured: 'node_pty', nodePty, tmux: unavailableTmux() }),
  );
}

/**
 * The PTY service over a catalog; its repository, database and data directory come from the caller, so a test can
 * close the service scope and still read the rows it left behind.
 */
function ptyServiceLayer(catalog: Layer.Layer<PtyBackendCatalog>) {
  return PtyService.layerNoDeps.pipe(
    Layer.provide([
      catalog,
      LaunchEnvironment.layerNoDeps.pipe(
        Layer.provide([CliAccessNone, Layer.succeed(UserShell, testUserShell())]),
      ),
      PtyForegroundState.layer,
      publishOnlyRecordingEventBus('the PTY service does not subscribe').layer,
      Layer.succeed(UserShell, testUserShell()),
    ]),
  );
}

function persistenceLayer(dataRoot: string) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabase.layer.pipe(Layer.provide(directory));
  return Layer.mergeAll(directory, database, PtyRepository.layer.pipe(Layer.provide(database)));
}

/** Builds `layer` in a scope the test closes itself. */
const buildInScope = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layer, scope);
    return { context, close: Scope.close(scope, Exit.void) };
  });

async function withDataRoot<A>(prefix: string, body: (dataRoot: string) => Promise<A>) {
  const dataRoot = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(dataRoot);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

// A real node process that lives until killed, named by a marker no other process carries.
function markedLongRunningProcess(marker: string) {
  return { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', marker] };
}

test('disposing the runtime terminates every live PTY and leaves no process', () =>
  withDataRoot('isagi-pty-dispose-', (dataRoot) => {
    const marker = `isagi-pty-dispose-${randomUUID()}`;
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* PtyRepository;
          const service = yield* buildInScope(ptyServiceLayer(realNodePtyCatalog));
          const pty = Context.get(service.context, PtyService);
          const launched = yield* Effect.forEach([1, 2], () =>
            pty.launch({ ...markedLongRunningProcess(marker), cwd: process.cwd() }),
          );
          for (const { ptyProcessId } of launched) {
            assert.equal((yield* repository.findProcess(ptyProcessId))?.status, 'running');
          }

          yield* service.close;

          yield* expectNoProcessMatching(marker);
          for (const { ptyProcessId } of launched) {
            const row = yield* repository.findProcess(ptyProcessId);
            assert.equal(row?.status, 'killed');
            assert.equal(row?.statusReason, 'runtime_shutdown');
          }
        }).pipe(
          Effect.provide(persistenceLayer(dataRoot)),
          // On a regression, do not leave the survivors keeping the test process alive.
          Effect.ensuring(Effect.sync(() => spawnSync('pkill', ['-f', marker]))),
        ),
      ),
    );
  }));

test('a launch interrupted before the process starts leaves no row in starting and no process', () =>
  withDataRoot('isagi-pty-interrupted-launch-', (dataRoot) => {
    const marker = `isagi-pty-interrupted-${randomUUID()}`;
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* PtyRepository;
          const service = yield* buildInScope(ptyServiceLayer(realNodePtyCatalog));
          const pty = Context.get(service.context, PtyService);
          const preparing = yield* Deferred.make<number>();

          const launch = yield* Effect.forkChild(
            pty.launch({
              ...markedLongRunningProcess(marker),
              cwd: process.cwd(),
              // Preparation never finishes: the interruption lands before any spawn.
              envForProcess: ({ ptyProcessId }) =>
                Deferred.succeed(preparing, ptyProcessId).pipe(Effect.andThen(Effect.never)),
            }),
          );
          const ptyProcessId = yield* Deferred.await(preparing);
          yield* Fiber.interrupt(launch);

          assert.deepEqual(yield* repository.listProcesses({ statuses: ['starting'] }), []);
          const row = yield* repository.findProcess(ptyProcessId);
          assert.equal(row?.status, 'failed');
          assert.equal(row?.statusReason, 'backend_launch_failed');
          yield* service.close;
          yield* expectNoProcessMatching(marker);
        }).pipe(Effect.provide(persistenceLayer(dataRoot))),
      ),
    );
  }));

test('PTY GC runs once per interval and never after scope close', () =>
  withDataRoot('isagi-pty-gc-loop-', (dataRoot) =>
    runWithTestClock(
      Effect.gen(function* () {
        const passes = yield* Ref.make(0);
        const backend = fakeNodePty({
          collectGarbage: () => Ref.update(passes, (n) => n + 1).pipe(Effect.as([])),
        });
        const service = yield* buildInScope(ptyServiceLayer(fakeCatalog(backend)));
        // The startup pass ran while the layer was built.
        assert.equal(yield* Ref.get(passes), 1);

        yield* TestClock.adjust('4 minutes');
        assert.equal(yield* Ref.get(passes), 1);
        yield* TestClock.adjust('1 minute');
        assert.equal(yield* Ref.get(passes), 2);
        yield* TestClock.adjust('5 minutes');
        assert.equal(yield* Ref.get(passes), 3);

        yield* service.close;
        yield* TestClock.adjust('1 hour');
        assert.equal(yield* Ref.get(passes), 3);
      }).pipe(Effect.provide(persistenceLayer(dataRoot))),
    ),
  ));

test('closing the PTY service scope stops the loops, sweeps, interrupts supervisors, then drains retries', () =>
  withDataRoot('isagi-pty-close-order-', (dataRoot) =>
    runWithTestClock(
      Effect.gen(function* () {
        const journal: string[] = [];
        const backend = fakeNodePty({
          launch: (input) =>
            Effect.succeed({
              ref: {
                schemaVersion: 1,
                backend: 'node_pty',
                ptyProcessId: input.ptyProcessId,
                pid: 4_242,
              },
              events: Stream.fromEffect(
                Effect.never.pipe(
                  Effect.onInterrupt(() =>
                    Effect.sync(() => journal.push('supervisor interrupted')),
                  ),
                ),
              ),
            }),
          // A poll tick that is still inspecting when the scope closes.
          inspect: () =>
            Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => journal.push('status poll interrupted'))),
            ),
          kill: () =>
            Effect.sync(() => {
              journal.push('shutdown sweep killed the process');
              return { terminated: true };
            }),
        });
        // The sweep's `killed` write fails once, so it is handed to the persistence retry.
        const flakyRepository = Layer.effect(
          PtyRepository,
          Effect.gen(function* () {
            const real = yield* PtyRepository;
            let failuresLeft = 1;
            return PtyRepository.of({
              ...real,
              transitionProcess: (input) => {
                if (input.status !== 'killed') return real.transitionProcess(input);
                if (failuresLeft-- > 0) {
                  return Effect.fail(
                    new DatabaseError({
                      operation: 'transition_pty_process',
                      cause: new Error('SQLITE_BUSY'),
                    }),
                  );
                }
                return real
                  .transitionProcess(input)
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => journal.push('retry landed the killed write')),
                    ),
                  );
              },
            });
          }),
        );
        const service = yield* buildInScope(
          ptyServiceLayer(fakeCatalog(backend)).pipe(Layer.provide(flakyRepository)),
        );
        const pty = Context.get(service.context, PtyService);
        const repository = yield* PtyRepository;
        const { ptyProcessId } = yield* pty.launch({
          command: 'pnpm',
          args: ['dev'],
          cwd: '/repo/isagi',
        });
        yield* TestClock.adjust('10 seconds');

        yield* service.close;

        assert.deepEqual(journal, [
          'status poll interrupted',
          'shutdown sweep killed the process',
          'supervisor interrupted',
          'retry landed the killed write',
        ]);
        assert.equal((yield* repository.findProcess(ptyProcessId))?.status, 'killed');
      }).pipe(Effect.provide(persistenceLayer(dataRoot))),
    ),
  ));

test('the shutdown sweep terminates every live PTY at once, in one shared grace inside the desktop stop budget', () =>
  withDataRoot('isagi-pty-shutdown-sweep-', (dataRoot) =>
    runWithTestClock(
      Effect.gen(function* () {
        const terminations: { readonly grace: number; readonly endedAt: number }[] = [];
        const backend = fakeNodePty({
          // Every incarnation spends its whole grace, as a tree that ignores SIGTERM would.
          terminate: ({ gracefulTimeoutMs }) =>
            Effect.gen(function* () {
              yield* Effect.sleep(gracefulTimeoutMs);
              const endedAt = yield* Clock.currentTimeMillis;
              terminations.push({ grace: gracefulTimeoutMs, endedAt });
              return { terminated: true };
            }),
        });
        const service = yield* buildInScope(ptyServiceLayer(fakeCatalog(backend)));
        const pty = Context.get(service.context, PtyService);
        const repository = yield* PtyRepository;
        const launched = yield* Effect.forEach([1, 2, 3, 4, 5], () =>
          pty.launch({ command: 'pnpm', args: ['dev'], cwd: '/repo/isagi' }),
        );
        const startedAt = yield* Clock.currentTimeMillis;

        const closing = yield* Effect.forkChild(service.close);
        // Far more than one grace, so a sequential sweep would finish too and show its stagger.
        yield* TestClock.adjust(launched.length * SHUTDOWN_GRACEFUL_TIMEOUT_MS * 2);
        yield* Fiber.join(closing);

        // The desktop SIGKILLs the runtime 3 s after SIGTERM; the sweep must end well before.
        assert.ok(SHUTDOWN_GRACEFUL_TIMEOUT_MS <= 1_500);
        assert.equal(terminations.length, launched.length);
        for (const { grace, endedAt } of terminations) {
          assert.equal(grace, SHUTDOWN_GRACEFUL_TIMEOUT_MS);
          assert.equal(
            endedAt - startedAt,
            SHUTDOWN_GRACEFUL_TIMEOUT_MS,
            'all ended after one grace',
          );
        }
        for (const { ptyProcessId } of launched) {
          const row = yield* repository.findProcess(ptyProcessId);
          assert.equal(row?.status, 'killed');
          assert.equal(row?.statusReason, 'runtime_shutdown');
        }
      }).pipe(Effect.provide(persistenceLayer(dataRoot))),
    ),
  ));

test('a process supervisor records foreground changes and persists the exit it reports', () =>
  withDataRoot('isagi-pty-supervisor-', (dataRoot) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<PtyProcessEvent, Cause.Done>();
          const bus = publishOnlyRecordingEventBus('the PTY service does not subscribe');
          const backend = fakeNodePty({
            launch: (input) =>
              Effect.succeed({
                ref: {
                  schemaVersion: 1,
                  backend: 'node_pty',
                  ptyProcessId: input.ptyProcessId,
                  pid: 4_242,
                },
                events: Stream.fromQueue(events),
              }),
          });
          const layer = PtyService.layerNoDeps.pipe(
            Layer.provide([
              fakeCatalog(backend),
              LaunchEnvironment.layerNoDeps.pipe(
                Layer.provide([CliAccessNone, Layer.succeed(UserShell, testUserShell())]),
              ),
              PtyForegroundState.layer,
              bus.layer,
              Layer.succeed(UserShell, testUserShell()),
            ]),
          );
          const service = yield* buildInScope(layer);
          const pty = Context.get(service.context, PtyService);
          const repository = yield* PtyRepository;
          const { ptyProcessId } = yield* pty.launch({ command: 'zsh', args: [], cwd: '/repo' });

          yield* Queue.offer(events, { _tag: 'ForegroundChanged', state: 'working' });
          yield* eventually(() =>
            bus.events.some((event) => event.type === 'pty_foreground_command_started'),
          );
          yield* Queue.offer(events, { _tag: 'Exited', exitCode: 0, signal: null });
          yield* Queue.end(events);
          yield* eventually(() => bus.events.some((event) => event.type === 'pty_process_exited'));

          const row = yield* repository.findProcess(ptyProcessId);
          assert.equal(row?.status, 'exited');
          assert.equal(row?.exitCode, 0);
          yield* service.close;
        }).pipe(Effect.provide(persistenceLayer(dataRoot))),
      ),
    ),
  ));

test('an attachment forwards backend output in order and stops when its scope closes', () =>
  withDataRoot('isagi-pty-attach-scope-', (dataRoot) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const outputs: Queue.Enqueue<PtyOutputMessage>[] = [];
          let released = 0;
          const backend = fakeNodePty({
            attach: (input) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  outputs.push(input.output);
                  return { replayBytes: 0, write: () => Effect.void, resize: () => Effect.void };
                }),
                () =>
                  Effect.sync(() => {
                    released += 1;
                  }),
              ),
          });
          const service = yield* buildInScope(ptyServiceLayer(fakeCatalog(backend)));
          const pty = Context.get(service.context, PtyService);
          const { ptyProcessId } = yield* pty.launch({ command: 'zsh', args: [], cwd: '/repo' });

          const sent: PtyStreamOutputMessageSet[] = [];
          const attachScope = yield* Scope.make();
          const attachment = yield* pty
            .attach({ ptyProcessId, mode: 'interactive', send: (message) => sent.push(message) })
            .pipe(Scope.provide(attachScope));
          const output = outputs[0];
          assert.ok(output);
          Queue.offerUnsafe(output, { type: 'output', data: 'a' });
          Queue.offerUnsafe(output, { type: 'output', data: 'b' });
          Queue.offerUnsafe(output, { type: 'exit', exitCode: 0, signal: null });
          yield* eventually(() => sent.length === 3);
          assert.deepEqual(sent, [
            { type: 'output', data: 'a' },
            { type: 'output', data: 'b' },
            { type: 'exit', exitCode: 0, signal: null },
          ]);

          yield* Scope.close(attachScope, Exit.void);

          assert.equal(released, 1);
          Queue.offerUnsafe(output, { type: 'output', data: 'late' });
          yield* Effect.sleep('20 millis');
          assert.equal(sent.length, 3);
          // The service forgot the attachment, so its id no longer writes.
          const write = yield* pty
            .write({ ptyProcessId, attachmentId: attachment.attachmentId, data: 'x' })
            .pipe(Effect.result);
          assert.ok(Result.isFailure(write) && write.failure instanceof PtyServiceError);
          // A second attach is allowed again, and `detach` ends it early.
          const again = yield* pty.attach({ ptyProcessId, mode: 'interactive', send: () => {} });
          yield* again.detach;
          assert.equal(released, 2);
          yield* service.close;
        }).pipe(Effect.provide(persistenceLayer(dataRoot))),
      ),
    ),
  ));

// node-pty learns about an exit in its own callback: it stops reporting the process as live there and only enqueues
// `Exited`, which the supervisor persists on a later scheduler turn. Requests that run in between see a `running` row
// whose backend answers `missing` / "not live". None of them may record that as `runtime_ephemeral_lost`: terminal rows
// are immutable, so the clean exit the supervisor is about to write would be lost for good.
function inExitWindow(
  observe: (input: {
    readonly pty: PtyService['Service'];
    readonly ptyProcessId: number;
    readonly inspections: () => number;
  }) => Effect.Effect<void, unknown, Scope.Scope>,
) {
  return withDataRoot('isagi-pty-exit-in-flight-', (dataRoot) =>
    runWithTestClock(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<PtyProcessEvent, Cause.Done>();
        // Flipped where the node-pty adapter's `onExit` drops its live entry, before `Exited` reaches the supervisor.
        let exited = false;
        let inspections = 0;
        const backend = fakeNodePty({
          launch: (input) =>
            Effect.succeed({
              ref: {
                schemaVersion: 1,
                backend: 'node_pty',
                ptyProcessId: input.ptyProcessId,
                pid: 4_242,
              },
              events: Stream.fromQueue(events),
            }),
          inspect: () =>
            Effect.sync(() => {
              inspections += 1;
              return exited ? { status: 'missing' as const } : { status: 'alive' as const };
            }),
          attach: (input) =>
            Effect.fail(
              new PtyStartError({
                ptyProcessId: input.ref.backend === 'node_pty' ? input.ref.ptyProcessId : undefined,
                command: 'node_pty_attach',
                cwd: '',
                cause: new Error('node-pty process is not live.'),
              }),
            ),
          kill: () => Effect.die('nothing is left to kill'),
        });
        const service = yield* buildInScope(ptyServiceLayer(fakeCatalog(backend)));
        const pty = Context.get(service.context, PtyService);
        const repository = yield* PtyRepository;
        const { ptyProcessId } = yield* pty.launch({ command: 'zsh', args: [], cwd: '/repo' });
        assert.equal((yield* repository.findProcess(ptyProcessId))?.status, 'running');

        exited = true;
        yield* observe({ pty, ptyProcessId, inspections: () => inspections });

        const pending = yield* repository.findProcess(ptyProcessId);
        assert.equal(pending?.status, 'running');
        assert.equal(pending?.statusReason, null);

        yield* Queue.offer(events, { _tag: 'Exited', exitCode: 0, signal: null });
        yield* Queue.end(events);
        yield* untilSettled(
          repository.findProcess(ptyProcessId).pipe(Effect.map((row) => row?.status !== 'running')),
        );
        const row = yield* repository.findProcess(ptyProcessId);
        assert.equal(row?.status, 'exited');
        assert.equal(row?.statusReason, null);
        assert.equal(row?.exitCode, 0);
        yield* service.close;
      }).pipe(Effect.provide(persistenceLayer(dataRoot))),
    ),
  );
}

test('an attach failure inside the exit window leaves the exit to the supervisor', () =>
  inExitWindow(({ pty, ptyProcessId }) =>
    Effect.gen(function* () {
      // The plan reads `running`; the backend says "not live".
      const attach = yield* pty
        .attach({ ptyProcessId, mode: 'interactive', send: () => {} })
        .pipe(Effect.result);
      assert.ok(Result.isFailure(attach));
      assert.ok(attach.failure instanceof PtyServiceError);
      assert.equal(attach.failure.code, 'backend_attach_failed');
    }),
  ));

test('a cleanup audit inside the exit window finds nothing to kill and leaves the exit to the supervisor', () =>
  inExitWindow(({ pty, ptyProcessId }) =>
    Effect.gen(function* () {
      assert.equal(
        yield* pty.cleanupProcess({ ptyProcessId, reason: 'user_requested' }),
        'already_terminal',
      );
    }),
  ));

test('a status poll inside the exit window leaves the exit to the supervisor', () =>
  inExitWindow(({ inspections }) =>
    Effect.gen(function* () {
      const before = inspections();
      yield* TestClock.adjust('10 seconds');
      assert.ok(inspections() > before, 'the status poll inspected the row');
    }),
  ));

/** Yields to other fibers until `done` holds, without needing a clock; fails the test if it never does. */
const untilSettled = <E>(done: Effect.Effect<boolean, E>) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 1_000; turn += 1) {
      if (yield* done) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error('condition never held'));
  });

/** Waits, with real time, until `predicate` holds; fails the test after two seconds. */
const eventually = (predicate: () => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error('condition never held'));
      yield* Effect.sleep('5 millis');
    }
  });
