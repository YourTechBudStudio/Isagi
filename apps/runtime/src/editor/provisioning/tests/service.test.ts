import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Deferred, Duration, Effect, Exit, Fiber, Layer, Schedule, Tracer } from 'effect';
import { TestClock } from 'effect/testing';

import type { EditorProvisioningState } from '@isagi/contracts';

import { DataDirectory } from '../../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../../platform/persistence/testing.js';
import { EditorInstallIo } from '../install-io.js';
import { codeServerManifest } from '../manifest.js';
import {
  EditorProvisioning,
  EditorProvisioningBusy,
  EditorProvisioningSettings,
  editorProvisioningDeadline,
} from '../service.js';
import { pinnedVersion, recordingInstallIo, type InstallIoBehaviour } from './test-support.js';

function makeRoots() {
  const root = mkdtempSync(join(tmpdir(), 'isagi-editor-service-'));
  return {
    root,
    directory: makeTestDataDirectory(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Builds the service with explicit settings: boot provisioning on unless `startAtBoot` says otherwise. */
function withService<A, E>(
  input: {
    readonly startAtBoot?: boolean;
    readonly directory: DataDirectory['Service'];
    readonly io: EditorInstallIo['Service'];
    readonly deadline?: Duration.Input;
  },
  use: (service: EditorProvisioning['Service']) => Effect.Effect<A, E>,
) {
  return Effect.flatMap(EditorProvisioning, use).pipe(
    Effect.provide(
      EditorProvisioning.layerNoDeps.pipe(
        Layer.provide([
          settingsLayer(input.startAtBoot ?? true, input.deadline),
          Layer.succeed(DataDirectory, input.directory),
          Layer.succeed(EditorInstallIo, input.io),
        ]),
      ),
    ),
  );
}

/** Whether `start` begins the attempt, and optionally a short deadline. */
function settingsLayer(startAtBoot: boolean, deadline?: Duration.Input) {
  return Layer.succeed(EditorProvisioningSettings, {
    startAtBoot,
    deadline:
      deadline === undefined ? editorProvisioningDeadline : Duration.fromInputUnsafe(deadline),
  });
}

test('with startAtBoot off, start is a no-op and retry still provisions', async () => {
  const roots = makeRoots();
  try {
    const recorder = recordingInstallIo();
    const result = await Effect.runPromise(
      withService({ startAtBoot: false, directory: roots.directory, io: recorder.io }, (service) =>
        Effect.gen(function* () {
          yield* service.start;
          const afterStart = yield* service.state;
          const callsAfterStart = recorder.calls.length;
          const retried = yield* service.retry;
          return { afterStart, callsAfterStart, retried };
        }),
      ),
    );

    assert.deepEqual(result.afterStart, { status: 'checking', version: pinnedVersion });
    assert.equal(result.callsAfterStart, 0);
    assert.deepEqual(result.retried, { status: 'ready', version: pinnedVersion });
    assert.ok(recorder.calls.length > 0);
  } finally {
    roots.cleanup();
  }
});

test('a runtime walks checking, downloading, verifying, extracting, ready', async () => {
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
      withService({ directory: roots.directory, io: recorder.io }, (service) =>
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
      withService({ directory: roots.directory, io: recorder.io }, (service) =>
        Effect.gen(function* () {
          // Before any attempt has run the state is `checking`, which is not
          // ready and must refuse.
          const early = yield* Effect.result(service.requireReady);
          yield* service.retry;
          const ready = yield* Effect.result(service.requireReady);
          return { early, ready };
        }),
      ),
    );

    assert.ok(resolved.early._tag === 'Failure');
    assert.equal(
      resolved.early._tag === 'Failure' ? resolved.early.failure.reason : null,
      'editor_unavailable',
    );
    assert.ok(resolved.ready._tag === 'Success');
  } finally {
    roots.cleanup();
  }
});

test('a failed attempt is terminal, is never retried on a timer, and refuses requireReady', async () => {
  const roots = makeRoots();
  try {
    const recorder = recordingInstallIo({ downloadFailure: { status: 500 } });
    const result = await Effect.runPromise(
      withService({ directory: roots.directory, io: recorder.io }, (service) =>
        Effect.gen(function* () {
          yield* service.retry;
          // Nothing re-enters on its own: the attempt settles once and stays
          // settled until a user asks again. Advancing a test clock well past
          // any plausible retry interval is what makes "no timer" an assertion
          // rather than an absence of evidence.
          yield* TestClock.adjust(Duration.hours(1));
          const settled = yield* service.state;
          const guard = yield* Effect.result(service.requireReady);
          return { settled, guard, downloads: recorder.calls.filter((c) => c === 'downloadTo') };
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );

    assert.equal(result.settled.status, 'failed');
    assert.equal(
      result.settled.status === 'failed' ? result.settled.reason : null,
      'download_failed',
    );
    assert.equal(result.downloads.length, 1);
    assert.equal(
      result.guard._tag === 'Failure' ? result.guard.failure.reason : null,
      'editor_unavailable',
    );
    // The refusal carries the settled diagnostic, so a caller can say why.
    assert.ok(result.guard._tag === 'Failure' && result.guard.failure.diagnostic?.includes('500'));
  } finally {
    roots.cleanup();
  }
});

test('retry re-enters a settled failure and can succeed', async () => {
  const roots = makeRoots();
  try {
    const failing = { value: true };
    const base = recordingInstallIo();
    const io: EditorInstallIo['Service'] = {
      ...base.io,
      downloadTo: (input) =>
        failing.value
          ? recordingInstallIo({ downloadFailure: { status: 500 } }).io.downloadTo(input)
          : base.io.downloadTo(input),
    };

    const result = await Effect.runPromise(
      withService({ directory: roots.directory, io }, (service) =>
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
        const io: EditorInstallIo['Service'] = {
          ...base.io,
          downloadTo: (input) =>
            Effect.andThen(
              Deferred.succeed(reached, undefined),
              Effect.andThen(Deferred.await(release), base.io.downloadTo(input)),
            ),
        };

        return yield* withService({ directory: roots.directory, io }, (service) =>
          Effect.gen(function* () {
            const first = yield* Effect.forkChild(service.retry);
            yield* Deferred.await(reached);
            // The second press must not stack another 200 MB download behind
            // the first.
            const second = yield* Effect.result(service.retry);
            yield* Deferred.succeed(release, undefined);
            const settled = yield* Fiber.join(first);
            return { second, settled, downloads: base.calls.filter((c) => c === 'downloadTo') };
          }),
        );
      }),
    );

    assert.ok(outcome.second._tag === 'Failure');
    assert.ok(
      outcome.second._tag === 'Failure' && outcome.second.failure instanceof EditorProvisioningBusy,
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
      withService({ directory: roots.directory, io: recorder.io }, (service) =>
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
        const io: EditorInstallIo['Service'] = {
          ...base.io,
          downloadTo: (input) =>
            Effect.andThen(
              Deferred.succeed(reached, undefined),
              Effect.andThen(Deferred.await(release), base.io.downloadTo(input)),
            ),
        };

        return yield* withService({ directory: roots.directory, io }, (service) =>
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
        const io: EditorInstallIo['Service'] = {
          ...base.io,
          // Never completes: the deadline is the only thing that can end this.
          downloadTo: () =>
            Effect.andThen(
              Deferred.succeed(reached, undefined),
              Effect.never as Effect.Effect<{ readonly sha256: string }, never>,
            ),
        };

        return yield* withService(
          {
            directory: roots.directory,
            io,
            deadline: Duration.minutes(10),
          },
          (service) =>
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(service.retry);
              yield* Deferred.await(reached);
              yield* TestClock.adjust(Duration.minutes(11));
              const exit = yield* Fiber.await(fiber);
              return Exit.isSuccess(exit) ? exit.value : null;
            }),
        );
      }).pipe(Effect.provide(TestClock.layer())),
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
    const layer = EditorProvisioning.layerNoDeps.pipe(
      Layer.provide(settingsLayer(true)),
      Layer.provide(Layer.succeed(DataDirectory, roots.directory)),
      Layer.provide(Layer.succeed(EditorInstallIo, recorder.io)),
    );
    // Wired by reference (`EditorProvisioning.layer`) precisely so the control plane
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
    const io: EditorInstallIo['Service'] = {
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
      withService({ directory: roots.directory, io }, (service) =>
        Effect.gen(function* () {
          const first = yield* service.retry;
          const beforeFailure = yield* Effect.result(service.requireReady);
          failing.value = true;
          const second = yield* service.retry;
          const afterFailure = yield* Effect.result(service.requireReady);
          return { first, beforeFailure, second, afterFailure };
        }),
      ),
    );

    assert.equal(outcome.first.status, 'ready');
    assert.ok(outcome.beforeFailure._tag === 'Success');
    assert.equal(outcome.second.status, 'failed');
    // A stale installation must never survive a failed re-attempt.
    assert.ok(outcome.afterFailure._tag === 'Failure');
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
        const io: EditorInstallIo['Service'] = {
          ...base.io,
          // Blocks forever: only interruption can end this attempt.
          downloadTo: () =>
            Effect.andThen(
              Deferred.succeed(reached, undefined),
              Effect.never as Effect.Effect<{ readonly sha256: string }, never>,
            ),
        };

        return yield* withService({ directory: roots.directory, io }, (service) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(service.retry);
            yield* Deferred.await(reached);
            const before = yield* service.state;
            // This is what an aborted `POST /editor/provisioning/retry`
            // does: the route runs the attempt under the request's abort
            // signal, so a client that disconnects interrupts it.
            yield* Fiber.interrupt(fiber);
            const after = yield* service.state;
            const guard = yield* Effect.result(service.requireReady);
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
    assert.ok(outcome.guard._tag === 'Failure');

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
        const io: EditorInstallIo['Service'] = {
          ...base.io,
          // The second attempt takes the receipt fast path, so the step that has
          // to block is one that runs on *both* paths.
          assertExecutable: (path) =>
            blocking.value
              ? Effect.andThen(
                  Deferred.succeed(blocked, undefined),
                  Effect.andThen(Deferred.await(release), base.io.assertExecutable(path)),
                )
              : base.io.assertExecutable(path),
        };

        return yield* withService({ directory: roots.directory, io }, (service) =>
          Effect.gen(function* () {
            const first = yield* service.retry;
            blocking.value = true;
            const fiber = yield* Effect.forkChild(service.retry);
            yield* Deferred.await(blocked);
            // The projected state and the guard are two views of one fact:
            // while an attempt is in flight, neither says ready.
            const during = yield* service.state;
            const guard = yield* Effect.result(service.requireReady);
            yield* Deferred.succeed(release, undefined);
            const settled = yield* Fiber.join(fiber);
            const after = yield* Effect.result(service.requireReady);
            return { first, during, guard, settled, after };
          }),
        );
      }),
    );

    assert.equal(outcome.first.status, 'ready');
    assert.equal(outcome.during.status, 'checking');
    // The bug this pins: `requireReady` used to hand out the previous
    // installation while provisioning was already replacing its install root.
    assert.ok(outcome.guard._tag === 'Failure');
    assert.equal(outcome.settled.status, 'ready');
    assert.ok(outcome.after._tag === 'Success');
  } finally {
    roots.cleanup();
  }
});

test('every member of the service runs under a span named for it', async () => {
  // `state` and `requireReady` are effect values rather than functions, so nothing names them unless they open their
  // own span; an `editor_unavailable` from `requireReady` must still say which operation refused.
  const roots = makeRoots();
  const spans: string[] = [];
  const recordingTracer = Tracer.make({
    span(options) {
      spans.push(options.name);
      return Tracer.nativeTracer.span(options);
    },
  });
  try {
    const recorder = recordingInstallIo();
    await Effect.runPromise(
      withService({ directory: roots.directory, io: recorder.io }, (service) =>
        Effect.gen(function* () {
          yield* service.state;
          yield* Effect.result(service.requireReady);
          yield* service.retry;
        }),
      ).pipe(Effect.withTracer(recordingTracer)),
    );
    const members = new Set(
      ['state', 'requireReady', 'retry'].map((m) => `EditorProvisioning.${m}`),
    );
    assert.deepEqual(
      spans.filter((name) => members.has(name)),
      ['EditorProvisioning.state', 'EditorProvisioning.requireReady', 'EditorProvisioning.retry'],
    );
  } finally {
    roots.cleanup();
  }
});
