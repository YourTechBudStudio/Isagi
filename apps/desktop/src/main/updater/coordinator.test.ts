import assert from 'node:assert/strict';
import test from 'node:test';

import { Deferred, Duration, Effect, Exit, Fiber, Layer, Stream, SubscriptionRef } from 'effect';
import type { HttpClientError } from 'effect/http';
import { TestClock } from 'effect/testing';

import { runWithTestClock } from '@isagi/testing';

import { updaterSchedule } from './coordinator.js';
import { UpdaterDiagnostics, type UpdaterDiagnosticRecord } from './diagnostics.js';
import { DesktopUpdater } from './service.js';
import {
  activityResponse,
  buildUpdater,
  FakeUpdater,
  fakeRuntimeHttp,
  recordingDiagnostics,
  settle,
  testConfig,
} from './test-support.js';

type Readiness = 'clear' | 'unknown' | { readonly workingAgents: number };

/**
 * The self-updating composition over a fake electron-updater, an in-memory diagnostic trail and a
 * fake runtime. Building it is starting it; `stop` closes its scope.
 */
const harness = Effect.fnUntraced(function* (
  options: {
    readonly readiness?: Readiness;
    readonly respond?: () => Effect.Effect<Response, HttpClientError.HttpClientError>;
    readonly exitCommitted?: () => boolean;
    readonly requestInstall?: (install: () => void) => void;
    readonly diagnostics?: Layer.Layer<UpdaterDiagnostics>;
  } = {},
) {
  const adapter = new FakeUpdater();
  const trail = recordingDiagnostics();
  const respond = options.respond ?? (() => Effect.succeed(readinessResponse(options.readiness)));
  const subject = yield* buildUpdater(
    DesktopUpdater.layerSelfUpdating.pipe(
      Layer.provide(
        Layer.mergeAll(
          testConfig({
            loadUpdater: () => adapter,
            isExitCommitted: options.exitCommitted ?? (() => false),
            requestInstall: options.requestInstall ?? (() => undefined),
          }),
          options.diagnostics ?? trail.layer,
          fakeRuntimeHttp(respond),
        ),
      ),
    ),
  );
  return { ...subject, adapter, diagnostics: trail.records };
});

type Subject = Effect.Success<ReturnType<typeof harness>>;

function readinessResponse(readiness: Readiness = 'clear') {
  if (readiness === 'clear') return activityResponse(0);
  if (readiness === 'unknown')
    return new Response(
      JSON.stringify({
        error: {
          code: 'agent_session_activity_unavailable',
          status: 500,
          message: 'Agent session activity could not be read.',
          requestId: 'request-1',
        },
      }),
      { status: 500 },
    );
  return activityResponse(readiness.workingAgents);
}

/** Emits an electron-updater event and lets the updater apply it. */
const emit = (subject: Subject, event: string, value?: unknown) =>
  Effect.sync(() => subject.adapter.emit(event, value)).pipe(Effect.andThen(settle));

/** Advances virtual time and lets the fibers it woke run. */
const advance = (duration: Duration.Input) =>
  TestClock.adjust(duration).pipe(Effect.andThen(settle));

const run = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.andThen(settle));

test('start is idempotent, never downloads on its own, and checks at once', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const subject = yield* harness();
      assert.equal(subject.adapter.allowPrerelease, false);
      // The whole point of the surface: finding an update must produce news to act
      // on, never a silent fetch the user only learns about once it has finished.
      assert.equal(subject.adapter.autoDownload, false);
      assert.equal(subject.adapter.autoInstallOnAppQuit, false);
      assert.equal(subject.adapter.autoRunAppAfterInstall, true);
      // Building the layer is the only start there is: one set of listeners, one launch check.
      assert.equal(subject.adapter.listenerCount('error'), 1);

      // No waiting timer at all — the launch check has already gone out, and it
      // announces itself so the rail can say that Isagi looked.
      assert.equal(subject.adapter.checks, 1);
      assert.equal(subject.snapshot().state, 'checking');

      // Nobody asked for the launch check, so its outcome is not spent on the rail.
      yield* emit(subject, 'update-not-available', { version: '1.2.3' });
      assert.equal(subject.snapshot().state, 'idle');
      // The poll is four-hourly, starting one period after launch.
      yield* advance(Duration.subtract(updaterSchedule.repeatCheck, Duration.millis(1)));
      assert.equal(subject.adapter.checks, 1);
      yield* advance(Duration.millis(1));
      assert.equal(subject.adapter.checks, 2);
    }),
  ));

test('a launch check that fails takes its own token back down without reporting', () =>
  runWithTestClock(
    Effect.gen(function* () {
      // The user did not ask, so they do not see the failure — but they must not be
      // left looking at `checking…` for the rest of the session either.
      const subject = yield* harness();
      assert.equal(subject.snapshot().state, 'checking');

      yield* emit(subject, 'error', new Error('no provider'));

      assert.equal(subject.snapshot().state, 'idle');
      assert.deepEqual(
        subject.diagnostics.map((record) => record.code),
        ['updater_error'],
      );
    }),
  ));

test('manual no-update is visible for five seconds and a new check cancels that timer', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const subject = yield* harness();
      yield* emit(subject, 'update-not-available', { version: '1.2.3' });
      yield* run(subject.updater.checkForUpdates);
      assert.equal(subject.snapshot().state, 'checking');
      yield* emit(subject, 'update-not-available', { version: '1.2.3' });
      assert.equal(subject.snapshot().state, 'up_to_date');

      // A new check three seconds in takes the token down and cancels the return to idle.
      yield* advance('3 seconds');
      assert.equal(subject.snapshot().state, 'up_to_date');
      yield* run(subject.updater.checkForUpdates);
      assert.equal(subject.snapshot().state, 'checking');

      // Its own answer gets a full five seconds: the cancelled window does not cut it short.
      yield* emit(subject, 'update-not-available', { version: '1.2.3' });
      assert.equal(subject.snapshot().state, 'up_to_date');
      yield* advance('2 seconds');
      assert.equal(subject.snapshot().state, 'up_to_date');
      yield* advance('3 seconds');
      assert.equal(subject.snapshot().state, 'idle');
    }),
  ));

test('a found update waits for the user, and only then does the download own the lock', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const subject = yield* harness();
      yield* emit(subject, 'update-available', { version: '2.0.0' });

      // Found, and nothing fetched. This is the state the rail exists to show.
      assert.deepEqual(subject.snapshot(), {
        protocolVersion: 2,
        revision: 2,
        state: 'update_available',
        installedVersion: '1.2.3',
        targetVersion: '2.0.0',
      });
      assert.equal(subject.adapter.downloads, 0);

      yield* run(subject.updater.downloadUpdate);
      assert.equal(subject.adapter.downloads, 1);
      assert.deepEqual(subject.snapshot(), {
        protocolVersion: 2,
        revision: 3,
        state: 'downloading',
        installedVersion: '1.2.3',
        targetVersion: '2.0.0',
        progressPercent: 0,
      });

      // A download in flight owns the lock: neither a second check nor a second
      // press may start anything alongside it.
      yield* run(subject.updater.checkForUpdates);
      yield* run(subject.updater.downloadUpdate);
      assert.equal(subject.adapter.checks, 1);
      assert.equal(subject.adapter.downloads, 1);
      yield* emit(subject, 'download-progress', { percent: Number.POSITIVE_INFINITY });
      assert.equal(progressPercent(subject), 0);
      yield* emit(subject, 'download-progress', { percent: 140 });
      assert.equal(progressPercent(subject), 100);
      yield* emit(subject, 'update-downloaded', { version: '2.0.0' });
      assert.equal(subject.snapshot().state, 'ready');
      yield* advance(updaterSchedule.repeatCheck);
      assert.equal(subject.adapter.checks, 1);
    }),
  ));

function progressPercent(subject: Subject) {
  const snapshot = subject.snapshot();
  return snapshot.state === 'downloading' ? snapshot.progressPercent : -1;
}

test('a scheduled check never occupies the slot while a download waits to be pressed', () =>
  runWithTestClock(
    Effect.gen(function* () {
      // The control is enabled and the rail says nothing about a background check,
      // so a poll that claimed the in-flight slot would turn the press into a
      // silent no-op — and republish identical facts, so not even a revision would
      // arrive for the client to recover on.
      const subject = yield* harness();
      yield* emit(subject, 'update-available', { version: '2.0.0' });

      yield* advance(updaterSchedule.repeatCheck);
      assert.equal(subject.adapter.checks, 1, 'a scheduled check ran while an update was on offer');

      yield* run(subject.updater.downloadUpdate);
      assert.equal(subject.adapter.downloads, 1);
      assert.equal(subject.snapshot().state, 'downloading');
    }),
  ));

test('a scheduled check never occupies the slot while a failed download waits to be retried', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const subject = yield* harness();
      yield* emit(subject, 'update-available', { version: '2.0.0' });
      yield* run(subject.updater.downloadUpdate);
      yield* emit(subject, 'error', new Error('download failed'));
      assert.equal(subject.snapshot().state, 'failed');

      yield* advance(updaterSchedule.repeatCheck);
      assert.equal(subject.adapter.checks, 1, 'a scheduled check ran while a retry was on offer');

      yield* run(subject.updater.downloadUpdate);
      assert.equal(subject.adapter.downloads, 2);
      assert.equal(subject.snapshot().state, 'downloading');
    }),
  ));

test('scheduled failures preserve an older manual failure and scheduled success replaces it', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const subject = yield* harness();
      yield* emit(subject, 'update-not-available', { version: '1.2.3' });
      yield* run(subject.updater.checkForUpdates);
      yield* emit(subject, 'error', new Error('manual failed'));
      assert.equal(subject.snapshot().state, 'failed');

      yield* advance(updaterSchedule.repeatCheck);
      assert.equal(subject.adapter.checks, 3);
      yield* emit(subject, 'error', new Error('scheduled failed'));
      assert.equal(subject.snapshot().state, 'failed');
      yield* advance(updaterSchedule.repeatCheck);
      assert.equal(subject.adapter.checks, 4);
      yield* emit(subject, 'update-not-available', { version: '1.2.3' });
      assert.equal(subject.snapshot().state, 'idle');
      assert.equal(subject.diagnostics.length, 2);
    }),
  ));

test('download errors stay visible and name what they failed to fetch', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const subject = yield* harness();
      yield* emit(subject, 'update-available', { version: '2.0.0' });
      yield* run(subject.updater.downloadUpdate);
      yield* emit(subject, 'error', new Error('download failed'));
      const snapshot = subject.snapshot();
      assert.equal(snapshot.state, 'failed');
      assert.equal(snapshot.state === 'failed' ? snapshot.operation : '', 'download');
      // The version survives the transition off `downloading`, so the failure can
      // name what it failed to fetch.
      assert.equal(
        snapshot.state === 'failed' && snapshot.operation === 'download'
          ? snapshot.targetVersion
          : '',
        '2.0.0',
      );
    }),
  ));

test('a download failure without a usable provider version still produces a snapshot', () =>
  runWithTestClock(
    Effect.gen(function* () {
      // A malformed provider event should degrade the sentence the user reads, not
      // leave the coordinator unable to report the failure at all.
      const subject = yield* harness();
      yield* emit(subject, 'update-available', {});
      yield* run(subject.updater.downloadUpdate);
      yield* emit(subject, 'error', new Error('download failed'));
      const snapshot = subject.snapshot();

      assert.equal(
        snapshot.state === 'failed' && snapshot.operation === 'download'
          ? snapshot.targetVersion
          : 'x',
        '',
      );
    }),
  ));

test('the download page failure is recorded on the same diagnostic trail as every other failure', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const subject = yield* harness();
      const report = yield* subject.updater.beginDownloadPageAttempt;
      yield* report('failed');

      assert.deepEqual(subject.diagnostics, [
        {
          operation: 'lifecycle',
          platform: 'darwin',
          installedVersion: '1.2.3',
          code: 'download_page_rejected',
          summary: 'The release download page could not be opened.',
        },
      ]);
    }),
  ));

test('a self-updating build has no manual state for a launch outcome to land on', () =>
  runWithTestClock(
    Effect.gen(function* () {
      // This composition never publishes `manual_update_required`, so there is
      // nothing for a success to retract and nothing for a failure to overlay. The
      // failure is still worth a line in the trail; the success is not.
      const subject = yield* harness();
      yield* emit(subject, 'update-not-available', { version: '1.2.3' });
      const report = yield* subject.updater.beginDownloadPageAttempt;
      yield* run(report('opened'));

      assert.deepEqual(subject.diagnostics, []);
      assert.equal(subject.snapshot().state, 'idle');
      assert.equal(subject.snapshot().revision, 2);
    }),
  ));

test('promise rejection and idle error events are diagnosed without duplicate visible transitions', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const subject = yield* harness();
      yield* emit(subject, 'update-not-available', { version: '1.2.3' });
      subject.adapter.rejection = new Error('https://user:secret@example.test/?token=hidden');
      yield* run(subject.updater.checkForUpdates);
      assert.equal(subject.snapshot().state, 'failed');
      yield* emit(subject, 'error', new Error('late idle error'));
      assert.deepEqual(
        subject.diagnostics.map((record) => record.code),
        ['check_rejected', 'idle_error'],
      );
    }),
  ));

test('revisions change only with visible facts and stop suppresses late events and flushes diagnostics', () =>
  runWithTestClock(
    Effect.gen(function* () {
      // The trail holds every write until the test opens it, so a write is in flight at stop.
      const gate = yield* Deferred.make<void>();
      const written: UpdaterDiagnosticRecord[] = [];
      const gatedTrail = Layer.succeed(
        UpdaterDiagnostics,
        UpdaterDiagnostics.of({
          write: (record) =>
            Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => void written.push(record)))),
        }),
      );
      const subject = yield* harness({ diagnostics: gatedTrail });
      const revisions: number[] = [];
      // The current snapshot first (the launch check's `checking`), then every change.
      yield* SubscriptionRef.changes(subject.updater.status).pipe(
        Stream.runForEach((snapshot) => Effect.sync(() => void revisions.push(snapshot.revision))),
        Effect.forkScoped,
      );
      yield* settle;
      yield* emit(subject, 'update-available', { version: '2.0.0' });
      yield* run(subject.updater.downloadUpdate);
      yield* emit(subject, 'download-progress', { percent: 10 });
      yield* emit(subject, 'download-progress', { percent: 10 });
      assert.deepEqual(revisions, [1, 2, 3, 4]);

      const report = yield* subject.updater.beginDownloadPageAttempt;
      yield* Effect.forkChild(report('failed'));
      yield* settle;
      let stopped = false;
      const stopping = yield* Effect.forkChild(
        subject.stop.pipe(Effect.andThen(Effect.sync(() => (stopped = true)))),
      );
      yield* settle;
      assert.equal(stopped, false, 'stop returned before the diagnostic in flight was written');
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(stopping);
      assert.equal(written.length, 1);
      yield* subject.stop;

      yield* emit(subject, 'update-downloaded', { version: '2.0.0' });
      assert.equal(subject.snapshot().state, 'downloading');
      assert.equal(subject.adapter.listenerCount('error'), 0);
      yield* advance(updaterSchedule.repeatCheck);
      assert.equal(subject.adapter.checks, 1, 'the poll outlived stop');
    }),
  ));

/** checking (1) · update_available (2) · downloading (3) · ready (4). */
const reachReady = (subject: Subject) =>
  Effect.gen(function* () {
    yield* emit(subject, 'update-available', { version: '2.0.0' });
    yield* run(subject.updater.downloadUpdate);
    yield* emit(subject, 'update-downloaded', { version: '2.0.0' });
  });

test('clear restart readiness installs while working and unknown readiness require confirmation', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const handedOver: (() => void)[] = [];
      const clear = yield* harness({ requestInstall: (install) => void handedOver.push(install) });
      yield* reachReady(clear);
      yield* clear.updater.requestRestart;
      assert.equal(clear.snapshot().state, 'installing');
      assert.equal(handedOver.length, 1);
      // What main is handed is the updater's own installer.
      handedOver[0]!();
      assert.equal(clear.adapter.installs, 1);

      const working = yield* harness({ readiness: { workingAgents: 2 } });
      yield* reachReady(working);
      yield* working.updater.requestRestart;
      assert.deepEqual(working.snapshot(), {
        protocolVersion: 2,
        revision: 5,
        state: 'restart_confirmation',
        installedVersion: '1.2.3',
        targetVersion: '2.0.0',
        activity: { kind: 'working', workingAgentCount: 2 },
      });

      const unknown = yield* harness({ readiness: 'unknown' });
      yield* reachReady(unknown);
      yield* unknown.updater.requestRestart;
      const snapshot = unknown.snapshot();
      assert.equal(
        snapshot.state === 'restart_confirmation' ? snapshot.activity.kind : '',
        'unknown',
      );
      // The runtime answered with an error envelope: diagnosed as an HTTP failure.
      assert.deepEqual(unknown.diagnostics, [
        {
          operation: 'readiness',
          platform: 'darwin',
          installedVersion: '1.2.3',
          code: 'restart_readiness_http',
          summary: 'Restart readiness failed during http.',
        },
      ]);
    }),
  ));

test('restart cancellation preserves the target and confirmation installs without rechecking', () =>
  runWithTestClock(
    Effect.gen(function* () {
      let reads = 0;
      let installs = 0;
      const subject = yield* harness({
        respond: () =>
          Effect.sync(() => {
            reads += 1;
            return activityResponse(1);
          }),
        requestInstall: () => (installs += 1),
      });
      yield* reachReady(subject);
      yield* subject.updater.requestRestart;
      yield* subject.updater.cancelRestart;
      assert.deepEqual(subject.snapshot(), {
        protocolVersion: 2,
        revision: 6,
        state: 'ready',
        installedVersion: '1.2.3',
        targetVersion: '2.0.0',
      });
      yield* subject.updater.requestRestart;
      yield* subject.updater.confirmRestart;
      yield* subject.updater.confirmRestart;
      assert.equal(subject.snapshot().state, 'installing');
      assert.equal(reads, 2);
      assert.equal(installs, 1);
    }),
  ));

test('committed exit and stop suppress restart work and checks in terminal restart states', () =>
  runWithTestClock(
    Effect.gen(function* () {
      let committed = false;
      let installs = 0;
      const subject = yield* harness({
        exitCommitted: () => committed,
        requestInstall: () => (installs += 1),
      });
      yield* reachReady(subject);
      committed = true;
      yield* subject.updater.requestRestart;
      assert.equal(subject.snapshot().state, 'ready');
      assert.equal(installs, 0);

      committed = false;
      yield* subject.updater.requestRestart;
      yield* run(subject.updater.checkForUpdates);
      assert.equal(subject.adapter.checks, 1);
    }),
  ));

test('a readiness read that dies or is interrupted leaves restart requestable', () =>
  runWithTestClock(
    Effect.gen(function* () {
      let mode: 'die' | 'hang' | 'clear' = 'die';
      let installs = 0;
      const subject = yield* harness({
        respond: () =>
          mode === 'die'
            ? Effect.die(new Error('readiness defect'))
            : mode === 'hang'
              ? Effect.never
              : Effect.succeed(activityResponse(0)),
        requestInstall: () => (installs += 1),
      });
      yield* reachReady(subject);

      assert.equal(Exit.isFailure(yield* Effect.exit(subject.updater.requestRestart)), true);
      assert.equal(subject.snapshot().state, 'ready');

      mode = 'hang';
      const hanging = yield* Effect.forkChild(subject.updater.requestRestart);
      yield* settle;
      yield* Fiber.interrupt(hanging);
      assert.equal(subject.snapshot().state, 'ready');

      // Neither outcome may keep the single-flight marker set: the next request
      // still has to reach a decision.
      mode = 'clear';
      yield* subject.updater.requestRestart;
      assert.equal(subject.snapshot().state, 'installing');
      assert.equal(installs, 1);
    }),
  ));

test('restart readiness is single-flight and a result arriving after stop is ignored', () =>
  runWithTestClock(
    Effect.gen(function* () {
      let reads = 0;
      let resolveRead!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        resolveRead = resolve;
      });
      const subject = yield* harness({
        respond: () =>
          Effect.suspend(() => {
            reads += 1;
            return Effect.promise(() => pending);
          }),
      });
      yield* reachReady(subject);
      const first = yield* Effect.forkChild(subject.updater.requestRestart);
      const duplicate = yield* Effect.forkChild(subject.updater.requestRestart);
      yield* settle;
      assert.equal(reads, 1);
      yield* subject.stop;
      resolveRead(activityResponse(0));
      yield* Fiber.join(first);
      yield* Fiber.join(duplicate);
      assert.equal(subject.snapshot().state, 'ready');
    }),
  ));
