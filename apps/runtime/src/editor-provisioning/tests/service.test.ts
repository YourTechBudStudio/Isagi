import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  TestClock,
  TestContext,
} from 'effect';

import type { EditorProvisioningState } from '@isagi/contracts';

import { DataDirectory, type DataDirectoryService } from '../../persistence/index.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import {
  EditorProvisioning,
  EditorProvisioningBusy,
  editorCapabilityFromEnvironment,
  makeEditorProvisioning,
  type EditorCapability,
  type EditorProvisioningService,
} from '../editor-provisioning.service.js';
import { EditorInstallIo, type EditorInstallIoService } from '../install-io.js';
import { codeServerManifest } from '../manifest.js';
import { pinnedVersion, recordingInstallIo, type InstallIoBehaviour } from './test-support.js';

function makeRoots() {
  const root = mkdtempSync(join(tmpdir(), 'isagi-editor-service-'));
  return {
    root,
    directory: makeTestDataDirectory(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Builds the service with an explicit capability.
 *
 * No test in this file reads or writes `process.env`. The runtime suite runs
 * every file in one process, so a capability that had to be installed as a
 * process global would make these assertions depend on every other test's
 * cleanup discipline.
 */
function withService<A, E>(
  input: {
    readonly capability: EditorCapability;
    readonly directory: DataDirectoryService;
    readonly io: EditorInstallIoService;
    readonly deadline?: Duration.DurationInput;
  },
  use: (service: EditorProvisioningService) => Effect.Effect<A, E>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* makeEditorProvisioning({
        capability: input.capability,
        ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
      }).pipe(
        Effect.provideService(DataDirectory, input.directory),
        Effect.provideService(EditorInstallIo, input.io),
      );
      return yield* use(service);
    }),
  );
}

test('the capability reader accepts only the exact declaration', () => {
  assert.equal(
    editorCapabilityFromEnvironment({ ISAGI_EDITOR_CAPABILITY: 'code_server' }),
    'code_server',
  );
  assert.equal(editorCapabilityFromEnvironment({}), null);
  assert.equal(editorCapabilityFromEnvironment({ ISAGI_EDITOR_CAPABILITY: '' }), null);
  assert.equal(editorCapabilityFromEnvironment({ ISAGI_EDITOR_CAPABILITY: 'Code_Server' }), null);
  assert.equal(editorCapabilityFromEnvironment({ ISAGI_EDITOR_CAPABILITY: 'vscode' }), null);
});

test('an undeclared runtime reports not_applicable, performs no IO, and writes no provider content', async () => {
  const roots = makeRoots();
  try {
    const recorder = recordingInstallIo();
    const result = await Effect.runPromise(
      withService({ capability: null, directory: roots.directory, io: recorder.io }, (service) =>
        Effect.gen(function* () {
          yield* service.start;
          const afterStart = yield* service.state;
          const retried = yield* service.retry;
          const guard = yield* Effect.either(service.requireReady);
          return { afterStart, retried, guard };
        }),
      ),
    );

    assert.deepEqual(result.afterStart, { status: 'not_applicable' });
    // Retry is a report, not an operation that needs an installation, so
    // `not_applicable` is its complete successful answer.
    assert.deepEqual(result.retried, { status: 'not_applicable' });
    assert.ok(result.guard._tag === 'Left');
    assert.equal(
      result.guard._tag === 'Left' ? result.guard.left.reason : null,
      'editor_unsupported_runtime',
    );

    assert.deepEqual(recorder.calls, []);
    // The generic Isagi-owned roots may exist; provider content may not.
    assert.ok(!existsSync(join(roots.directory.paths.toolsPath, 'code-server')));
    assert.ok(!existsSync(join(roots.directory.paths.toolsPath, '.staging')));
    assert.ok(!existsSync(join(roots.directory.paths.editorsPath, 'code-server')));
  } finally {
    roots.cleanup();
  }
});

test('a declared runtime walks checking, downloading, verifying, extracting, ready', async () => {
  const roots = makeRoots();
  try {
    // Observed from inside the IO seam, so each recorded status is the state the
    // control plane would actually have projected at that moment.
    const observed: string[] = [];
    let observeState: Effect.Effect<EditorProvisioningState> | null = null;
    const behaviour: InstallIoBehaviour = {
      observe: () =>
        observeState
          ? Effect.map(observeState, (state) => {
              observed.push(state.status);
            })
          : Effect.void,
    };
    const recorder = recordingInstallIo(behaviour);

    const final = await Effect.runPromise(
      withService(
        { capability: 'code_server', directory: roots.directory, io: recorder.io },
        (service) =>
          Effect.gen(function* () {
            observeState = service.state;
            const initial = yield* service.state;
            observed.push(initial.status);
            const settled = yield* service.retry;
            return settled;
          }),
      ),
    );

    // Consecutive duplicates collapsed: observation happens inside each IO call,
    // and several calls run under the same phase. `verifying` performs no IO at
    // all, so it cannot be seen from here — `install.phases.test.ts` is what
    // proves the full `downloading → verifying → extracting` order is emitted.
    const distinct = observed.filter((status, index) => status !== observed[index - 1]);
    assert.deepEqual(distinct, ['checking', 'downloading', 'extracting']);
    assert.deepEqual(final, { status: 'ready', version: pinnedVersion });
    assert.equal(final.status === 'ready' ? final.version : null, codeServerManifest.version);
  } finally {
    roots.cleanup();
  }
});

test('a ready service hands out the resolved installation; every other state refuses', async () => {
  const roots = makeRoots();
  try {
    const recorder = recordingInstallIo();
    const resolved = await Effect.runPromise(
      withService(
        { capability: 'code_server', directory: roots.directory, io: recorder.io },
        (service) =>
          Effect.gen(function* () {
            // Before any attempt has run the state is `checking`, which is not
            // ready and must refuse.
            const early = yield* Effect.either(service.requireReady);
            yield* service.retry;
            const ready = yield* Effect.either(service.requireReady);
            return { early, ready };
          }),
      ),
    );

    assert.ok(resolved.early._tag === 'Left');
    assert.equal(
      resolved.early._tag === 'Left' ? resolved.early.left.reason : null,
      'editor_unavailable',
    );
    assert.ok(resolved.ready._tag === 'Right');
  } finally {
    roots.cleanup();
  }
});

test('a failed attempt is terminal, is never retried on a timer, and refuses requireReady', async () => {
  const roots = makeRoots();
  try {
    const recorder = recordingInstallIo({ downloadFailure: { status: 500 } });
    const result = await Effect.runPromise(
      withService(
        { capability: 'code_server', directory: roots.directory, io: recorder.io },
        (service) =>
          Effect.gen(function* () {
            yield* service.retry;
            // Nothing re-enters on its own: the attempt settles once and stays
            // settled until a user asks again. Advancing a test clock well past
            // any plausible retry interval is what makes "no timer" an assertion
            // rather than an absence of evidence.
            yield* TestClock.adjust(Duration.hours(1));
            const settled = yield* service.state;
            const guard = yield* Effect.either(service.requireReady);
            return { settled, guard, downloads: recorder.calls.filter((c) => c === 'downloadTo') };
          }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    );

    assert.equal(result.settled.status, 'failed');
    assert.equal(
      result.settled.status === 'failed' ? result.settled.reason : null,
      'download_failed',
    );
    assert.equal(result.downloads.length, 1);
    assert.equal(
      result.guard._tag === 'Left' ? result.guard.left.reason : null,
      'editor_unavailable',
    );
    // The refusal carries the settled diagnostic, so a caller can say why.
    assert.ok(result.guard._tag === 'Left' && result.guard.left.diagnostic?.includes('500'));
  } finally {
    roots.cleanup();
  }
});

test('retry re-enters a settled failure and can succeed', async () => {
  const roots = makeRoots();
  try {
    const failing = { value: true };
    const base = recordingInstallIo();
    const io: EditorInstallIoService = {
      ...base.io,
      downloadTo: (input) =>
        failing.value
          ? recordingInstallIo({ downloadFailure: { status: 500 } }).io.downloadTo(input)
          : base.io.downloadTo(input),
    };

    const result = await Effect.runPromise(
      withService({ capability: 'code_server', directory: roots.directory, io }, (service) =>
        Effect.gen(function* () {
          const first = yield* service.retry;
          failing.value = false;
          const second = yield* service.retry;
          return { first, second };
        }),
      ),
    );

    assert.equal(result.first.status, 'failed');
    assert.equal(result.second.status, 'ready');
  } finally {
    roots.cleanup();
  }
});

test('a retry arriving while one is running is refused rather than queued', async () => {
  const roots = makeRoots();
  try {
    const base = recordingInstallIo();
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const io: EditorInstallIoService = {
          ...base.io,
          downloadTo: (input) =>
            Effect.zipRight(
              Deferred.succeed(reached, undefined),
              Effect.zipRight(Deferred.await(release), base.io.downloadTo(input)),
            ),
        };

        return yield* withService(
          { capability: 'code_server', directory: roots.directory, io },
          (service) =>
            Effect.gen(function* () {
              const first = yield* Effect.fork(service.retry);
              yield* Deferred.await(reached);
              // The second press must not stack another 200 MB download behind
              // the first.
              const second = yield* Effect.either(service.retry);
              yield* Deferred.succeed(release, undefined);
              const settled = yield* Fiber.join(first);
              return { second, settled, downloads: base.calls.filter((c) => c === 'downloadTo') };
            }),
        );
      }),
    );

    assert.ok(outcome.second._tag === 'Left');
    assert.ok(
      outcome.second._tag === 'Left' && outcome.second.left instanceof EditorProvisioningBusy,
    );
    assert.equal(outcome.settled.status, 'ready');
    assert.equal(outcome.downloads.length, 1);
  } finally {
    roots.cleanup();
  }
});

test('start is idempotent and runs at most one attempt', async () => {
  const roots = makeRoots();
  try {
    const recorder = recordingInstallIo();
    const downloads = await Effect.runPromise(
      withService(
        { capability: 'code_server', directory: roots.directory, io: recorder.io },
        (service) =>
          Effect.gen(function* () {
            yield* service.start;
            yield* service.start;
            yield* service.start;
            // Let the forked attempt settle.
            yield* Effect.repeat(service.state, {
              until: (state) => state.status === 'ready' || state.status === 'failed',
              // Spaced rather than immediate: an unspaced repeat busy-loops the
              // fiber the forked attempt needs in order to make progress.
              schedule: Schedule.spaced(Duration.millis(1)),
            });
            return recorder.calls.filter((call) => call === 'downloadTo').length;
          }),
      ),
    );
    assert.equal(downloads, 1);
  } finally {
    roots.cleanup();
  }
});

test('start returns while its attempt is still running', async () => {
  const roots = makeRoots();
  try {
    const base = recordingInstallIo();
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const io: EditorInstallIoService = {
          ...base.io,
          downloadTo: (input) =>
            Effect.zipRight(
              Deferred.succeed(reached, undefined),
              Effect.zipRight(Deferred.await(release), base.io.downloadTo(input)),
            ),
        };

        return yield* withService(
          { capability: 'code_server', directory: roots.directory, io },
          (service) =>
            Effect.gen(function* () {
              // This is the invariant the host's fatal 15-second readiness
              // deadline depends on: `start` forks. If it ever awaited the
              // attempt, a first-run 200 MB download would sit between the
              // listen call and `ISAGI_RUNTIME_READY`, and the desktop would
              // kill the runtime.
              yield* service.start;
              yield* Deferred.await(reached);
              const duringAttempt = yield* service.state;
              yield* Deferred.succeed(release, undefined);
              yield* Effect.repeat(service.state, {
                until: (state) => state.status === 'ready' || state.status === 'failed',
                schedule: Schedule.spaced(Duration.millis(1)),
              });
              return duringAttempt;
            }),
        );
      }),
    );

    // `start` had already returned while the download was still in flight.
    assert.equal(observed.status, 'downloading');
  } finally {
    roots.cleanup();
  }
});

test('an attempt that outruns its deadline settles as a timeout and leaves no staging', async () => {
  const roots = makeRoots();
  try {
    const base = recordingInstallIo();
    const settled = await Effect.runPromise(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const io: EditorInstallIoService = {
          ...base.io,
          // Never completes: the deadline is the only thing that can end this.
          downloadTo: () =>
            Effect.zipRight(
              Deferred.succeed(reached, undefined),
              Effect.never as Effect.Effect<{ readonly sha256: string }, never>,
            ),
        };

        return yield* withService(
          {
            capability: 'code_server',
            directory: roots.directory,
            io,
            deadline: Duration.minutes(10),
          },
          (service) =>
            Effect.gen(function* () {
              const fiber = yield* Effect.fork(service.retry);
              yield* Deferred.await(reached);
              yield* TestClock.adjust(Duration.minutes(11));
              const exit = yield* Fiber.await(fiber);
              return Exit.isSuccess(exit) ? exit.value : null;
            }),
        );
      }).pipe(Effect.provide(TestContext.TestContext)),
    );

    assert.equal(settled?.status, 'failed');
    assert.equal(settled?.status === 'failed' ? settled.reason : null, 'download_failed');
    assert.ok(settled?.status === 'failed' && settled.diagnostic?.includes('timed out'));

    const stagingRoot = join(roots.directory.paths.toolsPath, '.staging');
    assert.deepEqual(existsSync(stagingRoot) ? readdirSync(stagingRoot) : [], []);
  } finally {
    roots.cleanup();
  }
});

test('a state Ref is not shared between two constructions of the service', async () => {
  const roots = makeRoots();
  try {
    const recorder = recordingInstallIo();
    const layer = Layer.scoped(
      EditorProvisioning,
      makeEditorProvisioning({ capability: 'code_server' }),
    ).pipe(
      Layer.provide(Layer.succeed(DataDirectory, roots.directory)),
      Layer.provide(Layer.succeed(EditorInstallIo, recorder.io)),
    );
    // Provided by reference in `runtime.layer.ts` precisely so the control plane
    // and the API observe one attempt; this asserts the state really is
    // per-construction, which is what makes that sharing necessary.
    const [first, second] = await Effect.runPromise(
      Effect.all([
        Effect.scoped(
          Effect.flatMap(EditorProvisioning, (s) => s.retry).pipe(Effect.provide(layer)),
        ),
        Effect.scoped(
          Effect.flatMap(EditorProvisioning, (s) => s.state).pipe(Effect.provide(layer)),
        ),
      ]),
    );
    assert.equal(first.status, 'ready');
    assert.equal(second.status, 'checking');
  } finally {
    roots.cleanup();
  }
});

test('a failed attempt clears any previously resolved installation', async () => {
  const roots = makeRoots();
  try {
    const base = recordingInstallIo();
    const failing = { value: false };
    const io: EditorInstallIoService = {
      ...base.io,
      // Fails on the *shared state* step rather than the download, because after
      // a successful first attempt the second one legitimately takes the receipt
      // fast path and never downloads anything. Failing a step that runs on both
      // paths is what actually exercises the transition back out of `ready`.
      prepareEditorState: (input) =>
        failing.value
          ? recordingInstallIo({ prepareEditorStateFails: true }).io.prepareEditorState(input)
          : base.io.prepareEditorState(input),
    };
    const outcome = await Effect.runPromise(
      withService({ capability: 'code_server', directory: roots.directory, io }, (service) =>
        Effect.gen(function* () {
          const first = yield* service.retry;
          const beforeFailure = yield* Effect.either(service.requireReady);
          failing.value = true;
          const second = yield* service.retry;
          const afterFailure = yield* Effect.either(service.requireReady);
          return { first, beforeFailure, second, afterFailure };
        }),
      ),
    );

    assert.equal(outcome.first.status, 'ready');
    assert.ok(outcome.beforeFailure._tag === 'Right');
    assert.equal(outcome.second.status, 'failed');
    // A stale installation must never survive a failed re-attempt.
    assert.ok(outcome.afterFailure._tag === 'Left');
  } finally {
    roots.cleanup();
  }
});

test('an interrupted attempt settles as a failure instead of staying transient', async () => {
  const roots = makeRoots();
  try {
    const base = recordingInstallIo();
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const io: EditorInstallIoService = {
          ...base.io,
          // Blocks forever: only interruption can end this attempt.
          downloadTo: () =>
            Effect.zipRight(
              Deferred.succeed(reached, undefined),
              Effect.never as Effect.Effect<{ readonly sha256: string }, never>,
            ),
        };

        return yield* withService(
          { capability: 'code_server', directory: roots.directory, io },
          (service) =>
            Effect.gen(function* () {
              const fiber = yield* Effect.fork(service.retry);
              yield* Deferred.await(reached);
              const before = yield* service.state;
              // This is what an aborted `POST /editor/provisioning/retry`
              // does: the route runs the attempt under the request's abort
              // signal, so a client that disconnects interrupts it.
              yield* Fiber.interrupt(fiber);
              const after = yield* service.state;
              const guard = yield* Effect.either(service.requireReady);
              return { before, after, guard };
            }),
        );
      }),
    );

    assert.equal(outcome.before.status, 'downloading');
    // The projection settles, so a poller sees the retry affordance rather than
    // a download that never ends.
    assert.equal(outcome.after.status, 'failed');
    assert.equal(
      outcome.after.status === 'failed' ? outcome.after.reason : null,
      'install_unusable',
    );
    assert.ok(
      outcome.after.status === 'failed' && outcome.after.diagnostic?.includes('interrupted'),
    );
    assert.ok(outcome.guard._tag === 'Left');

    // And the interrupted attempt left nothing staged behind.
    const stagingRoot = join(roots.directory.paths.toolsPath, '.staging');
    assert.deepEqual(existsSync(stagingRoot) ? readdirSync(stagingRoot) : [], []);
  } finally {
    roots.cleanup();
  }
});

test('a retry from ready withdraws readiness for as long as it is running', async () => {
  const roots = makeRoots();
  try {
    const base = recordingInstallIo();
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const blocked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const blocking = { value: false };
        const io: EditorInstallIoService = {
          ...base.io,
          // The second attempt takes the receipt fast path, so the step that has
          // to block is one that runs on *both* paths.
          assertExecutable: (path) =>
            blocking.value
              ? Effect.zipRight(
                  Deferred.succeed(blocked, undefined),
                  Effect.zipRight(Deferred.await(release), base.io.assertExecutable(path)),
                )
              : base.io.assertExecutable(path),
        };

        return yield* withService(
          { capability: 'code_server', directory: roots.directory, io },
          (service) =>
            Effect.gen(function* () {
              const first = yield* service.retry;
              blocking.value = true;
              const fiber = yield* Effect.fork(service.retry);
              yield* Deferred.await(blocked);
              // The projected state and the guard are two views of one fact:
              // while an attempt is in flight, neither says ready.
              const during = yield* service.state;
              const guard = yield* Effect.either(service.requireReady);
              yield* Deferred.succeed(release, undefined);
              const settled = yield* Fiber.join(fiber);
              const after = yield* Effect.either(service.requireReady);
              return { first, during, guard, settled, after };
            }),
        );
      }),
    );

    assert.equal(outcome.first.status, 'ready');
    assert.equal(outcome.during.status, 'checking');
    // The bug this pins: `requireReady` used to hand out the previous
    // installation while provisioning was already replacing its install root.
    assert.ok(outcome.guard._tag === 'Left');
    assert.equal(outcome.settled.status, 'ready');
    assert.ok(outcome.after._tag === 'Right');
  } finally {
    roots.cleanup();
  }
});
