import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Cause, Duration, Effect, Exit, Layer, ManagedRuntime, SubscriptionRef } from 'effect';

import type { DesktopUpdateSnapshot, HostRuntimeStatusSnapshot } from '@isagi/contracts';
import { makeLogCapture } from '@isagi/testing';

import {
  DESKTOP_UPDATE_CHANNEL,
  DesktopShell,
  makeDesktopServices,
  RUNTIME_STATUS_CHANNEL,
} from './desktop-layer.js';
import {
  type RuntimeChildProcess,
  type RuntimeLifecycleFailure,
  RuntimeProcess,
  RuntimeProcessConfig,
} from './runtime-process/index.js';
import { DesktopUpdater, DesktopUpdaterConfig } from './updater/index.js';
import { activityResponse, FakeUpdater, fakeRuntimeHttp } from './updater/test-support.js';

class FakeStream extends EventEmitter {
  write(value: string) {
    this.emit('data', Buffer.from(value));
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly pid = 4242;
  killed = false;

  ready(port: number) {
    this.stdout.write(`ISAGI_RUNTIME_READY {"url":"http://127.0.0.1:${port}"}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null) {
    this.emit('exit', code, signal);
  }
}

/** electron-updater whose listener removals land in the shared order log. */
class RecordingUpdater extends FakeUpdater {
  constructor(private readonly order: string[]) {
    super();
  }

  override off(event: Parameters<FakeUpdater['off']>[0], listener: (...args: unknown[]) => void) {
    this.order.push(`updater off ${event}`);
    return super.off(event, listener);
  }
}

/**
 * The desktop services over fakes: a managed runtime child, electron-updater, the runtime's HTTP API and the Electron
 * shell. The runtime is a `ManagedRuntime`, built and disposed the way `index.ts` does it.
 */
function harness(
  options: {
    readonly selfUpdating?: boolean;
    readonly isPackaged?: boolean;
    /** A path, or the shell's own `logsDirectory` (one that throws, as `app.getPath` can). */
    readonly logsDirectory?: string | (() => string);
    /** Like `onRequestExit`: main's coordinator hands over to the installer by disposing the runtime first. */
    readonly requestInstall?: (
      install: () => void,
      runtime: ManagedRuntime.ManagedRuntime<unknown, never>,
    ) => void;
    /** Runs when the shell is asked to exit, as main's coordinator does: synchronously, from the caller's stack. */
    readonly onRequestExit?: (runtime: ManagedRuntime.ManagedRuntime<unknown, never>) => void;
  } = {},
) {
  const order: string[] = [];
  const sends: { readonly channel: string; readonly payload: unknown }[] = [];
  const exits: number[] = [];
  const requests: string[] = [];
  const child = new FakeChild();
  let spawns = 0;
  const updater = new RecordingUpdater(order);
  const logs = makeLogCapture();

  const runtimeProcessConfig = Layer.succeed(
    RuntimeProcessConfig,
    RuntimeProcessConfig.of({
      target: {
        ownership: 'managed',
        prepare: Effect.succeed({
          command: 'electron',
          args: ['index.js'],
          cwd: '/stage',
          env: {},
          processGroupOwnership: 'self',
        }),
      },
      adapter: {
        spawn: () => {
          spawns += 1;
          return child as unknown as RuntimeChildProcess;
        },
        signal: (_child, signal) => {
          order.push(`runtime ${signal}`);
          queueMicrotask(() => child.exit(0, signal));
        },
      },
      checkHealth: () => Effect.void,
      log: () => undefined,
      readinessTimeout: Duration.seconds(15),
      stopGrace: Duration.seconds(3),
    }),
  );

  const updaterConfig = (
    runtimeUrl: Effect.Effect<string, RuntimeLifecycleFailure, RuntimeProcess>,
  ) =>
    Layer.effect(
      DesktopUpdaterConfig,
      Effect.gen(function* () {
        const context = yield* Effect.context<RuntimeProcess>();
        return DesktopUpdaterConfig.of({
          platform: 'darwin',
          installedVersion: '1.2.3',
          isPackaged: options.selfUpdating ?? false,
          environment: {},
          logsDirectory: () => {
            throw new Error('the updater trail is not written by this test');
          },
          loadUpdater: () => updater,
          isExitCommitted: () => false,
          requestInstall: (install) =>
            options.requestInstall?.(
              install,
              runtime as ManagedRuntime.ManagedRuntime<unknown, never>,
            ),
          runtimeUrl: Effect.provideContext(runtimeUrl, context),
        });
      }),
    );

  const logsDirectory = options.logsDirectory;
  const shell = DesktopShell.of({
    send: (channel, payload) => void sends.push({ channel, payload }),
    requestExit: (code) => {
      exits.push(code);
      options.onRequestExit?.(runtime as ManagedRuntime.ManagedRuntime<unknown, never>);
    },
    isPackaged: options.isPackaged ?? false,
    logsDirectory:
      typeof logsDirectory === 'function'
        ? logsDirectory
        : () => logsDirectory ?? assert.fail('no logs directory in this test'),
  });

  const runtime = ManagedRuntime.make(
    makeDesktopServices({ runtimeProcessConfig, updaterConfig }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopShell, shell),
          fakeRuntimeHttp((request) =>
            Effect.sync(() => {
              requests.push(request.url);
              return activityResponse(0);
            }),
          ),
          logs.layer,
        ),
      ),
    ),
  );

  const runtimeSends = () =>
    sends
      .filter((send) => send.channel === RUNTIME_STATUS_CHANNEL)
      .map((send) => send.payload as HostRuntimeStatusSnapshot);
  const updateSends = () =>
    sends
      .filter((send) => send.channel === DESKTOP_UPDATE_CHANNEL)
      .map((send) => send.payload as DesktopUpdateSnapshot);
  const updateSnapshot = () =>
    runtime.runPromise(DesktopUpdater.use((service) => SubscriptionRef.get(service.status)));

  return {
    child,
    exits,
    logs: logs.lines,
    order,
    requests,
    runtime,
    runtimeSends,
    spawns: () => spawns,
    updateSends,
    updateSnapshot,
    updater,
  };
}

/** Lets fibers, listeners and the fake child's microtasks run until `condition` holds. */
async function until(condition: () => boolean | Promise<boolean>) {
  for (let turn = 0; turn < 2_000; turn += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('the condition was never reached');
}

/** Starts the managed runtime and reports it ready on `port`. */
async function startRuntime(subject: ReturnType<typeof harness>, port: number) {
  const started = subject.runtime.runPromise(RuntimeProcess.use((process) => process.start));
  await until(() => subject.spawns() === 1);
  subject.child.ready(port);
  await started;
}

test('disposing the desktop runtime stops the updater before the runtime process', async () => {
  const subject = harness({ selfUpdating: true });
  await startRuntime(subject, 43129);
  // The updater was built (and checked at once) with its listeners attached.
  assert.equal(subject.updater.checks, 1);
  assert.equal(subject.order.length, 0);

  await subject.runtime.dispose();

  const detached = subject.order.filter((entry) => entry.startsWith('updater off '));
  assert.equal(detached.length, 6);
  assert.deepEqual(subject.order, [...detached, 'runtime SIGTERM']);
});

test('disposing a desktop runtime that never built stops nothing', async () => {
  const subject = harness({ selfUpdating: true });
  await subject.runtime.dispose();
  assert.equal(subject.spawns(), 0);
  assert.equal(subject.updater.checks, 0);
  assert.deepEqual(subject.order, []);
});

test('the renderer is pushed the current runtime and update snapshots, then every later one', async () => {
  const subject = harness();
  try {
    await subject.runtime.runPromise(Effect.void);
    await until(() => subject.runtimeSends().length === 1 && subject.updateSends().length === 1);
    assert.deepEqual(
      subject.runtimeSends().map((snapshot) => [snapshot.revision, snapshot.state]),
      [[0, 'connecting']],
    );
    assert.deepEqual(subject.updateSends(), [await subject.updateSnapshot()]);
    assert.equal(subject.updateSends()[0]?.state, 'disabled');

    await startRuntime(subject, 43129);
    await until(() => subject.runtimeSends().length === 2);
    assert.deepEqual(
      subject.runtimeSends().map((snapshot) => [snapshot.revision, snapshot.state]),
      [
        [0, 'connecting'],
        [1, 'ready'],
      ],
    );
  } finally {
    await subject.runtime.dispose();
  }
});

test('a failed managed runtime is logged, preserved when packaged, and exits nonzero without reaching the renderer', async () => {
  const logsDirectory = await mkdtemp(join(tmpdir(), 'isagi-desktop-layer-'));
  let disposal: Promise<void> | undefined;
  const subject = harness({
    isPackaged: true,
    logsDirectory,
    // Main's coordinator disposes the desktop runtime synchronously from inside the request.
    onRequestExit: (runtime) => {
      disposal = runtime.dispose();
    },
  });

  const started = subject.runtime.runPromiseExit(RuntimeProcess.use((process) => process.start));
  await until(() => subject.spawns() === 1);
  subject.child.exit(1, null);
  assert.equal(Exit.isFailure(await started), true);
  await until(() => subject.exits.length === 1 && disposal !== undefined);
  await disposal;

  assert.deepEqual(subject.exits, [1]);
  assert.deepEqual(
    subject.runtimeSends().map((snapshot) => snapshot.state),
    ['connecting'],
  );
  const record = JSON.parse(
    await readFile(join(logsDirectory, 'managed-runtime-failure.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(record.state, 'failed');
  assert.equal(record.reason, 'exited_before_ready');
  assert.equal(typeof record.recordedAt, 'string');
  assert.deepEqual(
    subject.logs.map((line) => [line.level, line.message.split(' {')[0]]),
    [
      ['Error', 'Managed runtime failed'],
      [
        'Error',
        `Managed runtime failure record written to ${join(logsDirectory, 'managed-runtime-failure.json')}`,
      ],
    ],
  );
});

test('a failed runtime still exits nonzero when the logs directory cannot be named', async () => {
  const subject = harness({
    isPackaged: true,
    logsDirectory: () => {
      throw new Error("Failed to get 'logs' path");
    },
  });
  try {
    const started = subject.runtime.runPromiseExit(RuntimeProcess.use((process) => process.start));
    await until(() => subject.spawns() === 1);
    subject.child.exit(1, null);
    await started;
    await until(() => subject.exits.length === 1);
    assert.deepEqual(subject.exits, [1]);
    assert.deepEqual(
      subject.logs.map((line) => [line.level, line.message.split(' {')[0]]),
      [
        ['Error', 'Managed runtime failed'],
        [
          'Error',
          "Failed to preserve managed runtime failure record: no logs directory Error: Failed to get 'logs' path",
        ],
      ],
    );
  } finally {
    await subject.runtime.dispose();
  }
});

test('an unpackaged failed runtime exits nonzero without writing a failure record', async () => {
  const subject = harness({ isPackaged: false });
  try {
    const started = subject.runtime.runPromiseExit(RuntimeProcess.use((process) => process.start));
    await until(() => subject.spawns() === 1);
    subject.child.exit(1, null);
    await started;
    await until(() => subject.exits.length === 1);
    assert.deepEqual(subject.exits, [1]);
    assert.deepEqual(
      subject.logs.map((line) => line.level),
      ['Error'],
    );
  } finally {
    await subject.runtime.dispose();
  }
});

test('the updater reads restart readiness from the runtime the runtime process started', async () => {
  const handedOver: (() => void)[] = [];
  const subject = harness({
    selfUpdating: true,
    requestInstall: (install) => void handedOver.push(install),
  });
  try {
    await startRuntime(subject, 43131);
    const run = (effect: Effect.Effect<void, never, DesktopUpdater>) =>
      subject.runtime.runPromise(effect);

    subject.updater.emit('update-available', { version: '2.0.0' });
    await until(async () => (await subject.updateSnapshot()).state === 'update_available');
    await run(DesktopUpdater.use((service) => service.downloadUpdate));
    subject.updater.emit('update-downloaded', { version: '2.0.0' });
    await until(async () => (await subject.updateSnapshot()).state === 'ready');
    await run(DesktopUpdater.use((service) => service.requestRestart));

    assert.equal(subject.requests.length, 1);
    assert.equal(new URL(subject.requests[0]!).origin, 'http://127.0.0.1:43131');
    assert.equal((await subject.updateSnapshot()).state, 'installing');
    assert.equal(handedOver.length, 1);
  } finally {
    await subject.runtime.dispose();
  }
});

test('handing over to the installer disposes the desktop runtime from inside the restart intent', async () => {
  let disposal: Promise<void> | undefined;
  let install: (() => void) | undefined;
  const subject = harness({
    selfUpdating: true,
    requestInstall: (handedOver, runtime) => {
      install = handedOver;
      disposal = runtime.dispose();
    },
  });
  await startRuntime(subject, 43132);
  subject.updater.emit('update-available', { version: '2.0.0' });
  await until(async () => (await subject.updateSnapshot()).state === 'update_available');
  await subject.runtime.runPromise(DesktopUpdater.use((service) => service.downloadUpdate));
  subject.updater.emit('update-downloaded', { version: '2.0.0' });
  await until(async () => (await subject.updateSnapshot()).state === 'ready');

  const intent = await subject.runtime.runPromiseExit(
    DesktopUpdater.use((service) => service.requestRestart),
  );
  // Disposal interrupted the intent that started it; main treats that as the quit proceeding.
  assert.equal(Exit.isFailure(intent) && Cause.hasInterruptsOnly(intent.cause), true);
  assert.notEqual(disposal, undefined);
  await disposal;

  const detached = subject.order.filter((entry) => entry.startsWith('updater off '));
  assert.equal(detached.length, 6);
  assert.deepEqual(subject.order, [...detached, 'runtime SIGTERM']);
  install?.();
  assert.equal(subject.updater.installs, 1);
});
