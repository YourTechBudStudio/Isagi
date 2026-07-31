import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { DesktopShutdownCoordinator, handleBeforeQuit, stopDesktopServices } from './shutdown.js';

test('shutdown stops the updater before the runtime and tolerates partial initialization', async () => {
  const order: string[] = [];
  const updater = {
    stop: () =>
      Effect.sync(() => {
        order.push('updater');
      }),
  };
  const runtime = {
    stop: () =>
      Effect.sync(() => {
        order.push('runtime');
      }),
  };
  await Effect.runPromise(stopDesktopServices(updater as never, runtime as never));
  assert.deepEqual(order, ['updater', 'runtime']);

  order.length = 0;
  await Effect.runPromise(stopDesktopServices(undefined, runtime as never));
  assert.deepEqual(order, ['runtime']);
});

function shutdownHarness(options: { readonly installThrows?: boolean } = {}) {
  const events: string[] = [];
  const exits: number[] = [];
  let diagnoses = 0;
  const coordinator = new DesktopShutdownCoordinator({
    desktopUpdater: () =>
      ({
        stop: () => Effect.sync(() => events.push('updater')),
      }) as never,
    runtimeLifecycle: {
      stop: () => Effect.sync(() => events.push('runtime')),
    } as never,
    destroyRenderer: () => events.push('renderer'),
    exit: (code) => exits.push(code),
    diagnoseInstallRejection: () => {
      diagnoses += 1;
    },
  });
  const install = () => {
    events.push('install');
    if (options.installThrows) throw new Error('installer secret');
  };
  return { coordinator, diagnoses: () => diagnoses, events, exits, install };
}

test('install disposition stops services once before invoking the installer and resists re-entry', async () => {
  const subject = shutdownHarness();
  const shutdown = subject.coordinator.request({
    kind: 'install_update',
    install: subject.install,
  });
  void subject.coordinator.request({ kind: 'ordinary', code: 0 });
  void subject.coordinator.request({ kind: 'ordinary', code: 143 });
  await shutdown;
  assert.equal(subject.coordinator.committed, true);
  assert.deepEqual(subject.events, ['renderer', 'updater', 'runtime', 'install']);
  assert.deepEqual(subject.exits, []);
});

test('ordinary exit cannot be upgraded to installation and preserves nonzero escalation', async () => {
  const subject = shutdownHarness();
  const shutdown = subject.coordinator.request({ kind: 'ordinary', code: 0 });
  void subject.coordinator.request({ kind: 'install_update', install: subject.install });
  void subject.coordinator.request({ kind: 'ordinary', code: 130 });
  await shutdown;
  assert.deepEqual(subject.events, ['renderer', 'updater', 'runtime']);
  assert.deepEqual(subject.exits, [130]);
});

test('synchronous installer rejection remains an install disposition and terminates nonzero', async () => {
  const subject = shutdownHarness({ installThrows: true });
  await subject.coordinator.request({ kind: 'install_update', install: subject.install });
  assert.deepEqual(subject.events, ['renderer', 'updater', 'runtime', 'install']);
  assert.deepEqual(subject.exits, [1]);
  assert.equal(subject.diagnoses(), 1);
  assert.equal(subject.coordinator.installHandoffStarted, false);
});

function beforeQuit(coordinator: DesktopShutdownCoordinator) {
  let prevented = false;
  let begun = false;
  handleBeforeQuit(
    {
      preventDefault: () => {
        prevented = true;
      },
    },
    coordinator,
    () => {
      begun = true;
    },
  );
  return { begun, prevented };
}

test('before-quit intercepts an uncommitted quit and never re-enters a committed shutdown', async () => {
  const subject = shutdownHarness();
  assert.deepEqual(beforeQuit(subject.coordinator), { begun: true, prevented: true });

  const shutdown = subject.coordinator.request({ kind: 'ordinary', code: 0 });
  assert.deepEqual(beforeQuit(subject.coordinator), { begun: false, prevented: true });
  await shutdown;
  assert.deepEqual(subject.exits, [0]);
});

test('before-quit lets the committed installer quit sequence terminate the app', async () => {
  const subject = shutdownHarness();
  await subject.coordinator.request({ kind: 'install_update', install: subject.install });
  assert.equal(subject.coordinator.installHandoffStarted, true);
  // This is the quit `quitAndInstall()` starts: preventing it would strand the
  // process instead of installing and relaunching.
  assert.deepEqual(beforeQuit(subject.coordinator), { begun: false, prevented: false });
});
