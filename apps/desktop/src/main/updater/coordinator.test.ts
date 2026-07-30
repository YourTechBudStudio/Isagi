import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { Effect } from 'effect';

import {
  UpdaterCoordinator,
  updaterSchedule,
  type UpdaterAdapter,
  type UpdaterTimers,
} from './coordinator.js';
import type { UpdaterDiagnosticRecord, UpdaterDiagnosticSink } from './diagnostics.js';

class FakeUpdater extends EventEmitter implements UpdaterAdapter {
  allowPrerelease = true;
  autoDownload = false;
  autoInstallOnAppQuit = true;
  checks = 0;
  rejection: Error | undefined;

  checkForUpdates() {
    this.checks += 1;
    return this.rejection ? Promise.reject(this.rejection) : Promise.resolve(null);
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

function harness() {
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
  });
  return { coordinator, diagnostics, flushes: () => flushes, timers, updater };
}

test('start is idempotent, configures stable automatic downloads, and owns fixed scheduling', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  await Effect.runPromise(subject.coordinator.start());
  assert.equal(subject.updater.allowPrerelease, false);
  assert.equal(subject.updater.autoDownload, true);
  assert.equal(subject.updater.autoInstallOnAppQuit, false);
  assert.equal(subject.updater.listenerCount('error'), 1);
  assert.deepEqual(
    [...subject.timers.timeouts.values()].map((timer) => timer.milliseconds),
    [30_000],
  );

  subject.timers.fireTimeout(updaterSchedule.firstCheckMs);
  assert.equal(subject.updater.checks, 1);
  assert.deepEqual(
    [...subject.timers.intervals.values()].map((timer) => timer.milliseconds),
    [14_400_000],
  );
  subject.updater.emit('update-not-available', { version: '1.2.3' });
  subject.timers.fireInterval(updaterSchedule.repeatCheckMs);
  assert.equal(subject.updater.checks, 2);
});

test('manual no-update is visible for five seconds and a new check cancels that timer', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
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

test('automatic download owns the lock, normalizes progress, and reaches ready', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  await Effect.runPromise(subject.coordinator.checkForUpdates());
  subject.updater.emit('update-available', { version: '2.0.0' });
  assert.deepEqual(subject.coordinator.snapshot, {
    protocolVersion: 1,
    revision: 2,
    state: 'downloading',
    installedVersion: '1.2.3',
    targetVersion: '2.0.0',
    progressPercent: 0,
  });
  await Effect.runPromise(subject.coordinator.checkForUpdates());
  assert.equal(subject.updater.checks, 1);
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
  subject.timers.fireTimeout(updaterSchedule.firstCheckMs);
  subject.timers.fireInterval(updaterSchedule.repeatCheckMs);
  assert.equal(subject.updater.checks, 1);
});

test('scheduled failures preserve an older manual failure and scheduled success replaces it', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  await Effect.runPromise(subject.coordinator.checkForUpdates());
  subject.updater.emit('error', new Error('manual failed'));
  assert.equal(subject.coordinator.snapshot.state, 'failed');

  subject.timers.fireTimeout(updaterSchedule.firstCheckMs);
  subject.updater.emit('error', new Error('scheduled failed'));
  assert.equal(subject.coordinator.snapshot.state, 'failed');
  subject.timers.fireInterval(updaterSchedule.repeatCheckMs);
  subject.updater.emit('update-not-available', { version: '1.2.3' });
  assert.equal(subject.coordinator.snapshot.state, 'idle');
  assert.equal(subject.diagnostics.length, 2);
});

test('download errors remain visible even when a scheduled check found the update', async () => {
  const subject = harness();
  await Effect.runPromise(subject.coordinator.start());
  subject.timers.fireTimeout(updaterSchedule.firstCheckMs);
  subject.updater.emit('update-available', { version: '2.0.0' });
  subject.updater.emit('error', new Error('download failed'));
  assert.equal(subject.coordinator.snapshot.state, 'failed');
  assert.equal(
    subject.coordinator.snapshot.state === 'failed' ? subject.coordinator.snapshot.operation : '',
    'download',
  );
});

test('promise rejection and idle error events are diagnosed without duplicate visible transitions', async () => {
  const subject = harness();
  subject.updater.rejection = new Error('https://user:secret@example.test/?token=hidden');
  await Effect.runPromise(subject.coordinator.start());
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
  await Effect.runPromise(subject.coordinator.checkForUpdates());
  subject.updater.emit('update-available', { version: '2.0.0' });
  subject.updater.emit('download-progress', { percent: 10 });
  subject.updater.emit('download-progress', { percent: 10 });
  assert.deepEqual(revisions, [1, 2, 3]);
  await Effect.runPromise(subject.coordinator.stop());
  await Effect.runPromise(subject.coordinator.stop());
  subject.updater.emit('update-downloaded', { version: '2.0.0' });
  assert.equal(subject.coordinator.snapshot.state, 'downloading');
  assert.equal(subject.timers.timeouts.size, 0);
  assert.equal(subject.timers.intervals.size, 0);
  assert.equal(subject.updater.listenerCount('error'), 0);
  assert.equal(subject.flushes(), 1);
});
