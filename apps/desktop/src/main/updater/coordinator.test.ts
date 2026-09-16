import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { Effect, Exit, Fiber } from 'effect';

import {
  UpdaterCoordinator,
  updaterSchedule,
  type UpdaterAdapter,
  type UpdaterTimers,
} from './coordinator.js';
import type { UpdaterDiagnosticRecord, UpdaterDiagnosticSink } from './diagnostics.js';

class FakeUpdater extends EventEmitter implements UpdaterAdapter {
  // Every flag starts at the opposite of what `start` must set, so a
  // configuration that silently stopped being applied cannot pass.
  allowPrerelease = true;
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  checks = 0;
  downloads = 0;
  installs = 0;
  rejection: Error | undefined;
  downloadRejection: Error | undefined;

  checkForUpdates() {
    this.checks += 1;
    return this.rejection ? Promise.reject(this.rejection) : Promise.resolve(null);
  }

  downloadUpdate() {
    this.downloads += 1;
    return this.downloadRejection ? Promise.reject(this.downloadRejection) : Promise.resolve(null);
  }

  quitAndInstall() {
    this.installs += 1;
  }

  override on(event: Parameters<UpdaterAdapter['on']>[0], listener: (...args: unknown[]) => void) {
    return super.on(event, listener);
  }

  override off(
    event: Parameters<UpdaterAdapter['off']>[0],
    listener: (...args: unknown[]) => void,
  ) {
    return super.off(event, listener);
  }
}

class FakeTimers implements UpdaterTimers {
  #next = 1;
  readonly timeouts = new Map<number, { callback: () => void; milliseconds: number }>();
  readonly intervals = new Map<number, { callback: () => void; milliseconds: number }>();

  setTimeout(callback: () => void, milliseconds: number) {
    const handle = this.#next++;
    this.timeouts.set(handle, { callback, milliseconds });
    return handle;
  }

  clearTimeout(handle: unknown) {
    this.timeouts.delete(handle as number);
  }

  setInterval(callback: () => void, milliseconds: number) {
    const handle = this.#next++;
    this.intervals.set(handle, { callback, milliseconds });
    return handle;
  }

  clearInterval(handle: unknown) {
    this.intervals.delete(handle as number);
  }

  fireTimeout(milliseconds: number) {
    const match = [...this.timeouts].find(([, timer]) => timer.milliseconds === milliseconds);
    assert.ok(match);
    this.timeouts.delete(match[0]);
    match[1].callback();
  }

  fireInterval(milliseconds: number) {
    const match = [...this.intervals.values()].find((timer) => timer.milliseconds === milliseconds);
    assert.ok(match);
    match.callback();
  }
}

function harness(
  options: {
    readiness?: import('./restart-readiness.js').RestartReadiness;
    readRestartReadiness?: () => Effect.Effect<import('./restart-readiness.js').RestartReadiness>;
    exitCommitted?: () => boolean;
    requestInstall?: () => void;
  } = {},
) {
  const updater = new FakeUpdater();
  const timers = new FakeTimers();
  const diagnostics: UpdaterDiagnosticRecord[] = [];
  let flushes = 0;
  const sink: UpdaterDiagnosticSink = {
    write: (record) => {
      diagnostics.push(record);
      return Promise.resolve();
    },
    flush: () => {
      flushes += 1;
      return Promise.resolve();
    },
  };
  const coordinator = new UpdaterCoordinator({
    updater,
    timers,
    diagnostics: sink,
    platform: 'darwin',
    installedVersion: '1.2.3',
    readRestartReadiness:
      options.readRestartReadiness ??
      (() => Effect.succeed(options.readiness ?? { kind: 'clear' })),
    isExitCommitted: options.exitCommitted ?? (() => false),
    requestInstall: options.requestInstall ?? (() => undefined),
  });
  return { coordinator, diagnostics, flushes: () => flushes, timers, updater };
}

test('start is idempotent, never downloads on its own, and checks at once', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  await Effect.runPromise(subject.coordinator.start());
  assert.equal(subject.updater.allowPrerelease, false);
  // The whole point of the surface: finding an update must produce news to act
  // on, never a silent fetch the user only learns about once it has finished.
  assert.equal(subject.updater.autoDownload, false);
  assert.equal(subject.updater.autoInstallOnAppQuit, false);
  assert.equal(subject.updater.autoRunAppAfterInstall, true);
  assert.equal(subject.updater.listenerCount('error'), 1);

  // No waiting timer at all — the launch check has already gone out, and it
  // announces itself so the rail can say that Isagi looked.
  assert.equal(subject.updater.checks, 1);
  assert.equal(snapshotState(subject.coordinator), 'checking');
  assert.deepEqual([...subject.timers.timeouts.values()], []);
  assert.deepEqual(
    [...subject.timers.intervals.values()].map((timer) => timer.milliseconds),
    [14_400_000],
  );

  // Nobody asked for the launch check, so its outcome is not spent on the rail.
  subject.updater.emit('update-not-available', { version: '1.2.3' });
  assert.equal(snapshotState(subject.coordinator), 'idle');
  subject.timers.fireInterval(updaterSchedule.repeatCheckMs);
  assert.equal(subject.updater.checks, 2);
});

test('a launch check that fails takes its own token back down without reporting', async () => {
  // The user did not ask, so they do not see the failure — but they must not be
  // left looking at `checking…` for the rest of the session either.
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  assert.equal(snapshotState(subject.coordinator), 'checking');

  subject.updater.emit('error', new Error('no provider'));

  assert.equal(snapshotState(subject.coordinator), 'idle');
  assert.deepEqual(
    subject.diagnostics.map((record) => record.code),
    ['updater_error'],
  );
});

test('manual no-update is visible for five seconds and a new check cancels that timer', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  subject.updater.emit('update-not-available', { version: '1.2.3' });
  await Effect.runPromise(subject.coordinator.checkForUpdates());
  assert.equal(snapshotState(subject.coordinator), 'checking');
  subject.updater.emit('update-not-available', { version: '1.2.3' });
  assert.equal(snapshotState(subject.coordinator), 'up_to_date');
  assert.equal(
    [...subject.timers.timeouts.values()].some((timer) => timer.milliseconds === 5_000),
    true,
  );
  await Effect.runPromise(subject.coordinator.checkForUpdates());
  assert.equal(snapshotState(subject.coordinator), 'checking');
  assert.equal(
    [...subject.timers.timeouts.values()].some((timer) => timer.milliseconds === 5_000),
    false,
  );
});

function snapshotState(coordinator: UpdaterCoordinator) {
  return coordinator.snapshot.state;
}

test('a found update waits for the user, and only then does the download own the lock', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  subject.updater.emit('update-available', { version: '2.0.0' });

  // Found, and nothing fetched. This is the state the rail exists to show.
  assert.deepEqual(subject.coordinator.snapshot, {
    protocolVersion: 2,
    revision: 2,
    state: 'update_available',
    installedVersion: '1.2.3',
    targetVersion: '2.0.0',
  });
  assert.equal(subject.updater.downloads, 0);

  await Effect.runPromise(subject.coordinator.downloadUpdate());
  assert.equal(subject.updater.downloads, 1);
  assert.deepEqual(subject.coordinator.snapshot, {
    protocolVersion: 2,
    revision: 3,
    state: 'downloading',
    installedVersion: '1.2.3',
    targetVersion: '2.0.0',
    progressPercent: 0,
  });

  // A download in flight owns the lock: neither a second check nor a second
  // press may start anything alongside it.
  await Effect.runPromise(subject.coordinator.checkForUpdates());
  await Effect.runPromise(subject.coordinator.downloadUpdate());
  assert.equal(subject.updater.checks, 1);
  assert.equal(subject.updater.downloads, 1);
  subject.updater.emit('download-progress', { percent: Number.POSITIVE_INFINITY });
  assert.equal(
    subject.coordinator.snapshot.state === 'downloading'
      ? subject.coordinator.snapshot.progressPercent
      : -1,
    0,
  );
  subject.updater.emit('download-progress', { percent: 140 });
  assert.equal(
    subject.coordinator.snapshot.state === 'downloading'
      ? subject.coordinator.snapshot.progressPercent
      : -1,
    100,
  );
  subject.updater.emit('update-downloaded', { version: '2.0.0' });
  assert.equal(subject.coordinator.snapshot.state, 'ready');
  subject.timers.fireInterval(updaterSchedule.repeatCheckMs);
  assert.equal(subject.updater.checks, 1);
});

test('a scheduled check never occupies the slot while a download waits to be pressed', async () => {
  // The control is enabled and the rail says nothing about a background check,
  // so a poll that claimed the in-flight slot would turn the press into a
  // silent no-op — and republish identical facts, so not even a revision would
  // arrive for the client to recover on.
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  subject.updater.emit('update-available', { version: '2.0.0' });

  subject.timers.fireInterval(updaterSchedule.repeatCheckMs);
  assert.equal(subject.updater.checks, 1, 'a scheduled check ran while an update was on offer');

  await Effect.runPromise(subject.coordinator.downloadUpdate());
  assert.equal(subject.updater.downloads, 1);
  assert.equal(subject.coordinator.snapshot.state, 'downloading');
});

test('a scheduled check never occupies the slot while a failed download waits to be retried', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  subject.updater.emit('update-available', { version: '2.0.0' });
  await Effect.runPromise(subject.coordinator.downloadUpdate());
  subject.updater.emit('error', new Error('download failed'));
  assert.equal(subject.coordinator.snapshot.state, 'failed');

  subject.timers.fireInterval(updaterSchedule.repeatCheckMs);
  assert.equal(subject.updater.checks, 1, 'a scheduled check ran while a retry was on offer');

  await Effect.runPromise(subject.coordinator.downloadUpdate());
  assert.equal(subject.updater.downloads, 2);
  assert.equal(subject.coordinator.snapshot.state, 'downloading');
});

test('scheduled failures preserve an older manual failure and scheduled success replaces it', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  subject.updater.emit('update-not-available', { version: '1.2.3' });
  await Effect.runPromise(subject.coordinator.checkForUpdates());
  subject.updater.emit('error', new Error('manual failed'));
  assert.equal(subject.coordinator.snapshot.state, 'failed');

  subject.timers.fireInterval(updaterSchedule.repeatCheckMs);
  subject.updater.emit('error', new Error('scheduled failed'));
  assert.equal(subject.coordinator.snapshot.state, 'failed');
  subject.timers.fireInterval(updaterSchedule.repeatCheckMs);
  subject.updater.emit('update-not-available', { version: '1.2.3' });
  assert.equal(subject.coordinator.snapshot.state, 'idle');
  assert.equal(subject.diagnostics.length, 2);
});

test('download errors stay visible and name what they failed to fetch', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  subject.updater.emit('update-available', { version: '2.0.0' });
  await Effect.runPromise(subject.coordinator.downloadUpdate());
  subject.updater.emit('error', new Error('download failed'));
  const snapshot = subject.coordinator.snapshot;
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.state === 'failed' ? snapshot.operation : '', 'download');
  // The version survives the transition off `downloading`, so the failure can
  // name what it failed to fetch.
  assert.equal(
    snapshot.state === 'failed' && snapshot.operation === 'download' ? snapshot.targetVersion : '',
    '2.0.0',
  );
});

test('a download failure without a usable provider version still produces a snapshot', async () => {
  // A malformed provider event should degrade the sentence the user reads, not
  // leave the coordinator unable to report the failure at all.
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  subject.updater.emit('update-available', {});
  await Effect.runPromise(subject.coordinator.downloadUpdate());
  subject.updater.emit('error', new Error('download failed'));
  const snapshot = subject.coordinator.snapshot;

  assert.equal(
    snapshot.state === 'failed' && snapshot.operation === 'download' ? snapshot.targetVersion : 'x',
    '',
  );
});

test('the download page failure is recorded on the same diagnostic trail as every other failure', async () => {
  const subject = harness();
  await subject.coordinator.beginDownloadPageAttempt()('failed');

  assert.deepEqual(subject.diagnostics, [
    {
      operation: 'lifecycle',
      platform: 'darwin',
      installedVersion: '1.2.3',
      code: 'download_page_rejected',
      summary: 'The release download page could not be opened.',
    },
  ]);
});

test('a self-updating build has no manual state for a launch outcome to land on', async () => {
  // This composition never publishes `manual_update_required`, so there is
  // nothing for a success to retract and nothing for a failure to overlay. The
  // failure is still worth a line in the trail; the success is not.
  const subject = harness();
  await subject.coordinator.beginDownloadPageAttempt()('opened');

  assert.deepEqual(subject.diagnostics, []);
  assert.equal(subject.coordinator.snapshot.state, 'idle');
});

test('promise rejection and idle error events are diagnosed without duplicate visible transitions', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  subject.updater.emit('update-not-available', { version: '1.2.3' });
  subject.updater.rejection = new Error('https://user:secret@example.test/?token=hidden');
  await Effect.runPromise(subject.coordinator.checkForUpdates());
  await Promise.resolve();
  assert.equal(subject.coordinator.snapshot.state, 'failed');
  subject.updater.emit('error', new Error('late idle error'));
  assert.deepEqual(
    subject.diagnostics.map((record) => record.code),
    ['check_rejected', 'idle_error'],
  );
});

test('revisions change only with visible facts and stop suppresses late events and flushes diagnostics', async () => {
  const subject = harness();
  const revisions: number[] = [];
  subject.coordinator.subscribe((snapshot) => revisions.push(snapshot.revision));
  await Effect.runPromise(subject.coordinator.start());
  subject.updater.emit('update-available', { version: '2.0.0' });
  await Effect.runPromise(subject.coordinator.downloadUpdate());
  subject.updater.emit('download-progress', { percent: 10 });
  subject.updater.emit('download-progress', { percent: 10 });
  assert.deepEqual(revisions, [1, 2, 3, 4]);
  await Effect.runPromise(subject.coordinator.stop());
  await Effect.runPromise(subject.coordinator.stop());
  subject.updater.emit('update-downloaded', { version: '2.0.0' });
  assert.equal(subject.coordinator.snapshot.state, 'downloading');
  assert.equal(subject.timers.timeouts.size, 0);
  assert.equal(subject.timers.intervals.size, 0);
  assert.equal(subject.updater.listenerCount('error'), 0);
  assert.equal(subject.flushes(), 1);
});

/** checking (1) · update_available (2) · downloading (3) · ready (4). */
async function reachReady(subject: ReturnType<typeof harness>) {
  await Effect.runPromise(subject.coordinator.start());
  subject.updater.emit('update-available', { version: '2.0.0' });
  await Effect.runPromise(subject.coordinator.downloadUpdate());
  subject.updater.emit('update-downloaded', { version: '2.0.0' });
}

test('clear restart readiness installs while working and unknown readiness require confirmation', async () => {
  let clearInstalls = 0;
  const clear = harness({ requestInstall: () => (clearInstalls += 1) });
  await reachReady(clear);
  await Effect.runPromise(clear.coordinator.requestRestart());
  assert.equal(clear.coordinator.snapshot.state, 'installing');
  assert.equal(clearInstalls, 1);

  const working = harness({
    readiness: { kind: 'working_agents', workingAgentCount: 2 },
  });
  await reachReady(working);
  await Effect.runPromise(working.coordinator.requestRestart());
  assert.deepEqual(working.coordinator.snapshot, {
    protocolVersion: 2,
    revision: 5,
    state: 'restart_confirmation',
    installedVersion: '1.2.3',
    targetVersion: '2.0.0',
    activity: { kind: 'working', workingAgentCount: 2 },
  });

  const unknown = harness({ readiness: { kind: 'unknown' } });
  await reachReady(unknown);
  await Effect.runPromise(unknown.coordinator.requestRestart());
  assert.equal(
    unknown.coordinator.snapshot.state === 'restart_confirmation'
      ? unknown.coordinator.snapshot.activity.kind
      : '',
    'unknown',
  );
});

test('restart cancellation preserves the target and confirmation installs without rechecking', async () => {
  let reads = 0;
  let installs = 0;
  const subject = harness({
    readRestartReadiness: () =>
      Effect.sync(() => {
        reads += 1;
        return { kind: 'working_agents', workingAgentCount: 1 } as const;
      }),
    requestInstall: () => (installs += 1),
  });
  await reachReady(subject);
  await Effect.runPromise(subject.coordinator.requestRestart());
  await Effect.runPromise(subject.coordinator.cancelRestart());
  assert.deepEqual(subject.coordinator.snapshot, {
    protocolVersion: 2,
    revision: 6,
    state: 'ready',
    installedVersion: '1.2.3',
    targetVersion: '2.0.0',
  });
  await Effect.runPromise(subject.coordinator.requestRestart());
  await Effect.runPromise(subject.coordinator.confirmRestart());
  await Effect.runPromise(subject.coordinator.confirmRestart());
  assert.equal(subject.coordinator.snapshot.state, 'installing');
  assert.equal(reads, 2);
  assert.equal(installs, 1);
});

test('committed exit and stop suppress restart work and checks in terminal restart states', async () => {
  let committed = false;
  let installs = 0;
  const subject = harness({
    exitCommitted: () => committed,
    requestInstall: () => (installs += 1),
  });
  await reachReady(subject);
  committed = true;
  await Effect.runPromise(subject.coordinator.requestRestart());
  assert.equal(subject.coordinator.snapshot.state, 'ready');
  assert.equal(installs, 0);

  committed = false;
  await Effect.runPromise(subject.coordinator.requestRestart());
  await Effect.runPromise(subject.coordinator.checkForUpdates());
  assert.equal(subject.updater.checks, 1);
});

test('a readiness read that dies or is interrupted leaves restart requestable', async () => {
  let mode: 'die' | 'hang' | 'clear' = 'die';
  let installs = 0;
  const subject = harness({
    readRestartReadiness: () =>
      mode === 'die'
        ? Effect.die(new Error('readiness defect'))
        : mode === 'hang'
          ? Effect.never
          : Effect.succeed({ kind: 'clear' } as const),
    requestInstall: () => (installs += 1),
  });
  await reachReady(subject);

  assert.equal(
    Exit.isFailure(await Effect.runPromiseExit(subject.coordinator.requestRestart())),
    true,
  );
  assert.equal(subject.coordinator.snapshot.state, 'ready');

  mode = 'hang';
  await Effect.runPromise(Fiber.interrupt(Effect.runFork(subject.coordinator.requestRestart())));
  assert.equal(subject.coordinator.snapshot.state, 'ready');

  // Neither outcome may keep the single-flight marker set: the next request
  // still has to reach a decision.
  mode = 'clear';
  await Effect.runPromise(subject.coordinator.requestRestart());
  assert.equal(subject.coordinator.snapshot.state, 'installing');
  assert.equal(installs, 1);
});

test('restart readiness is single-flight and a result arriving after stop is ignored', async () => {
  let reads = 0;
  let resolveRead!: (value: import('./restart-readiness.js').RestartReadiness) => void;
  const pending = new Promise<import('./restart-readiness.js').RestartReadiness>((resolve) => {
    resolveRead = resolve;
  });
  const subject = harness({
    readRestartReadiness: () => {
      reads += 1;
      return Effect.promise(() => pending);
    },
  });
  await reachReady(subject);
  const first = Effect.runPromise(subject.coordinator.requestRestart());
  const duplicate = Effect.runPromise(subject.coordinator.requestRestart());
  await Promise.resolve();
  assert.equal(reads, 1);
  await Effect.runPromise(subject.coordinator.stop());
  resolveRead({ kind: 'clear' });
  await Promise.all([first, duplicate]);
  assert.equal(subject.coordinator.snapshot.state, 'ready');
});
