import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Stream,
  SubscriptionRef,
} from 'effect';
import { TestClock } from 'effect/testing';

import type { HostRuntimeStatusSnapshot } from '@isagi/contracts';
import { makeLogCapture, runWithTestClock } from '@isagi/testing';

import {
  RuntimeLifecycleFailure,
  RuntimeProcess,
  RuntimeProcessConfig,
  type RuntimeTarget,
} from './lifecycle.js';
import type { RuntimeLogRecord, RuntimeLogSink } from './logging.js';
import type { RuntimeChildProcess, RuntimeProcessAdapter } from './process-adapter.js';

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

  exit(code: number | null, signal: NodeJS.Signals | null) {
    this.emit('exit', code, signal);
  }

  fail(error: Error) {
    this.emit('error', error);
  }
}

const readinessTimeout = Duration.seconds(15);
const stopGrace = Duration.seconds(3);

function managedTarget(): RuntimeTarget {
  return {
    ownership: 'managed',
    prepare: Effect.succeed({
      command: 'electron',
      args: ['index.js'],
      cwd: '/stage',
      env: {},
      processGroupOwnership: 'self',
    }),
  };
}

function harness(
  options: {
    readonly target?: RuntimeTarget;
    readonly checkHealth?: (url: string) => Effect.Effect<void, Error>;
    readonly spawnError?: Error;
    readonly exitOnTerm?: boolean;
    readonly exitOnKill?: boolean;
    readonly log?: RuntimeLogSink;
  } = {},
) {
  const child = new FakeChild();
  const signals: NodeJS.Signals[] = [];
  const logs: RuntimeLogRecord[] = [];
  let spawns = 0;
  const adapter: RuntimeProcessAdapter = {
    spawn: () => {
      spawns += 1;
      if (options.spawnError) throw options.spawnError;
      return child as unknown as RuntimeChildProcess;
    },
    signal: (_child, signal) => {
      signals.push(signal);
      if (
        (signal === 'SIGTERM' && options.exitOnTerm !== false) ||
        (signal === 'SIGKILL' && options.exitOnKill !== false)
      ) {
        queueMicrotask(() => child.exit(0, signal === 'SIGKILL' ? 'SIGKILL' : null));
      }
    },
  };
  const layer = RuntimeProcess.layer.pipe(
    Layer.provide(
      Layer.succeed(
        RuntimeProcessConfig,
        RuntimeProcessConfig.of({
          target: options.target ?? managedTarget(),
          adapter,
          checkHealth: options.checkHealth ?? (() => Effect.void),
          log: options.log ?? ((record) => logs.push(record)),
          readinessTimeout,
          stopGrace,
        }),
      ),
    ),
  );
  /** Runs `body` against a fresh `RuntimeProcess` under the TestClock; the layer's scope closes when `body` ends. */
  const run = <A, E>(body: (process: RuntimeProcess['Service']) => Effect.Effect<A, E>) =>
    runWithTestClock(RuntimeProcess.use(body).pipe(Effect.provide(layer)));
  return { child, logs, signals, spawns: () => spawns, run };
}

/** Lets forked fibers and the fake child's microtasks run; time stays frozen. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 20; turn += 1) yield* Effect.yieldNow;
});

const snapshotOf = (process: RuntimeProcess['Service']) => SubscriptionRef.get(process.status);

const failureReason = <A>(result: Result.Result<A, RuntimeLifecycleFailure>) =>
  Result.isFailure(result) ? result.failure.reason : undefined;

function ready(child: FakeChild, port = 43129) {
  child.stdout.write(`ISAGI_RUNTIME_RE`);
  child.stdout.write(`ADY {"url":"http://127.0.0.1:${port}"}\n`);
}

test('concurrent URL callers share one spawn and readiness plus health gate', async () => {
  const healthGate = Deferred.makeUnsafe<void>();
  const gated = harness({ checkHealth: () => Deferred.await(healthGate) });
  await gated.run((process) =>
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(process.url);
      const second = yield* Effect.forkChild(process.url);
      yield* settle;
      ready(gated.child);
      yield* settle;
      assert.equal(gated.spawns(), 1);
      assert.equal((yield* snapshotOf(process)).state, 'connecting');
      yield* Deferred.succeed(healthGate, undefined);
      assert.equal(yield* Fiber.join(first), 'http://127.0.0.1:43129/');
      assert.equal(yield* Fiber.join(second), 'http://127.0.0.1:43129/');
      assert.equal((yield* snapshotOf(process)).state, 'ready');
    }),
  );
});

test('malformed readiness is a stored terminal failure', async () => {
  const subject = harness();
  await subject.run((process) =>
    Effect.gen(function* () {
      const result = yield* Effect.forkChild(Effect.result(process.start));
      yield* settle;
      subject.child.stdout.write('ISAGI_RUNTIME_READY {"url":42}\n');
      assert.equal(failureReason(yield* Fiber.join(result)), 'readiness_malformed');
      assert.equal((yield* snapshotOf(process)).state, 'failed');
      const repeated = yield* Effect.result(process.url);
      assert.equal(failureReason(repeated), 'readiness_malformed');
      assert.equal(subject.spawns(), 1);
    }),
  );
});

test('readiness timeout is terminal and signals the child', async () => {
  const subject = harness();
  await subject.run((process) =>
    Effect.gen(function* () {
      const result = yield* Effect.forkChild(Effect.result(process.start));
      yield* settle;
      yield* TestClock.adjust(readinessTimeout);
      assert.equal(failureReason(yield* Fiber.join(result)), 'readiness_timeout');
      assert.deepEqual(subject.signals, ['SIGTERM']);
      const snapshot = yield* snapshotOf(process);
      assert.equal(
        snapshot.state === 'failed' ? snapshot.diagnostic?.message : undefined,
        'Runtime did not report readiness within 15000ms.',
      );
      // A later caller gets the stored failure without a respawn.
      assert.equal(failureReason(yield* Effect.result(process.url)), 'readiness_timeout');
      assert.equal(subject.spawns(), 1);
    }),
  );
});

test('spawn failure and pre-ready exit remain distinguishable', async () => {
  const spawnFailure = harness({ spawnError: new Error('spawn denied') });
  await spawnFailure.run((process) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(process.start);
      assert.equal(failureReason(result), 'spawn_failed');
      assert.equal(
        Result.isFailure(result) ? result.failure.diagnostic.message : undefined,
        'spawn denied',
      );
    }),
  );

  const earlyExit = harness();
  await earlyExit.run((process) =>
    Effect.gen(function* () {
      const result = yield* Effect.forkChild(Effect.result(process.start));
      yield* settle;
      earlyExit.child.exit(7, null);
      assert.equal(failureReason(yield* Fiber.join(result)), 'exited_before_ready');
      const snapshot = yield* snapshotOf(process);
      assert.equal(snapshot.state === 'failed' ? snapshot.diagnostic?.exitCode : undefined, 7);
      // The child is gone, so nothing is signalled.
      assert.deepEqual(earlyExit.signals, []);
    }),
  );
});

test('stage preparation and post-ready process errors retain their stable reasons', async () => {
  const stageFailure = harness({
    target: {
      ownership: 'managed',
      prepare: Effect.fail(
        new RuntimeLifecycleFailure({
          reason: 'stage_invalid',
          diagnostic: { message: 'metadata mismatch' },
        }),
      ),
    },
  });
  await stageFailure.run((process) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(process.start);
      assert.equal(failureReason(result), 'stage_invalid');
      assert.equal(stageFailure.spawns(), 0);
    }),
  );

  const launchFailure = harness({
    target: {
      ownership: 'managed',
      prepare: Effect.fail(
        new RuntimeLifecycleFailure({
          reason: 'launch_configuration_invalid',
          diagnostic: { message: 'no web origin' },
        }),
      ),
    },
  });
  await launchFailure.run((process) =>
    Effect.gen(function* () {
      assert.equal(
        failureReason(yield* Effect.result(process.start)),
        'launch_configuration_invalid',
      );
    }),
  );

  // Anything else preparation throws is reported as an invalid stage, with its message.
  const thrown = harness({
    target: {
      ownership: 'managed',
      prepare: Effect.sync(() => {
        throw new Error('stage metadata unreadable');
      }),
    },
  });
  await thrown.run((process) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(process.start);
      assert.equal(failureReason(result), 'stage_invalid');
      assert.equal(
        Result.isFailure(result) ? result.failure.diagnostic.message : undefined,
        'stage metadata unreadable',
      );
    }),
  );

  const processFailure = harness();
  await processFailure.run((process) =>
    Effect.gen(function* () {
      const started = yield* Effect.forkChild(process.start);
      yield* settle;
      ready(processFailure.child);
      yield* Fiber.join(started);
      processFailure.child.fail(new Error('pipe failed'));
      yield* settle;
      const snapshot = yield* snapshotOf(process);
      assert.equal(snapshot.state === 'failed' ? snapshot.reason : undefined, 'process_error');
      assert.equal(
        snapshot.state === 'failed' ? snapshot.diagnostic?.message : undefined,
        'pipe failed',
      );
      // The child may still be alive after a process error, so it is terminated.
      assert.deepEqual(processFailure.signals, ['SIGTERM']);
    }),
  );
});

test('health failure and post-ready exit remain distinguishable', async () => {
  const healthFailure = harness({ checkHealth: () => Effect.fail(new Error('health bad')) });
  await healthFailure.run((process) =>
    Effect.gen(function* () {
      const result = yield* Effect.forkChild(Effect.result(process.start));
      yield* settle;
      ready(healthFailure.child);
      const unhealthy = yield* Fiber.join(result);
      assert.equal(failureReason(unhealthy), 'health_check_failed');
      assert.equal(
        Result.isFailure(unhealthy) ? unhealthy.failure.diagnostic.message : undefined,
        'health bad',
      );
    }),
  );

  const postReady = harness();
  await postReady.run((process) =>
    Effect.gen(function* () {
      const url = yield* Effect.forkChild(process.url);
      yield* settle;
      ready(postReady.child);
      assert.equal(yield* Fiber.join(url), 'http://127.0.0.1:43129/');
      postReady.child.exit(null, 'SIGABRT');
      yield* settle;
      const snapshot = yield* snapshotOf(process);
      assert.equal(snapshot.state, 'failed');
      assert.equal(snapshot.state === 'failed' ? snapshot.reason : undefined, 'exited_after_ready');
      assert.equal(
        snapshot.state === 'failed' ? snapshot.diagnostic?.signal : undefined,
        'SIGABRT',
      );
      // A crashed runtime no longer hands out its URL.
      assert.equal(failureReason(yield* Effect.result(process.url)), 'exited_after_ready');
      assert.deepEqual(postReady.signals, []);
    }),
  );
});

test('intentional repeated stop is idempotent and never publishes failure', async () => {
  const subject = harness();
  await subject.run((process) =>
    Effect.gen(function* () {
      const snapshots: HostRuntimeStatusSnapshot[] = [];
      yield* Effect.forkChild(
        Stream.runForEach(SubscriptionRef.changes(process.status), (snapshot) =>
          Effect.sync(() => snapshots.push(snapshot)),
        ),
      );
      const started = yield* Effect.forkChild(process.start);
      yield* settle;
      ready(subject.child);
      yield* Fiber.join(started);
      subject.child.stderr.write('\u001b[31mfinal diagnostic\u001b[0m');
      yield* Effect.all([process.stop, process.stop], { concurrency: 'unbounded' });
      yield* settle;
      assert.deepEqual(subject.signals, ['SIGTERM']);
      assert.deepEqual(
        snapshots.map((snapshot) => [snapshot.revision, snapshot.state]),
        [
          [0, 'connecting'],
          [1, 'ready'],
        ],
      );
      assert.equal(subject.logs.at(-1)?.payload, '\u001b[31mfinal diagnostic\u001b[0m');
      // Stopped is terminal.
      assert.equal(failureReason(yield* Effect.result(process.start)), 'process_error');
    }),
  );
});

test('intentional stop during startup settles pending start and URL waiters', async () => {
  const subject = harness();
  await subject.run((process) =>
    Effect.gen(function* () {
      const startResult = yield* Effect.forkChild(Effect.result(process.start));
      const urlResult = yield* Effect.forkChild(Effect.result(process.url));
      yield* settle;

      yield* process.stop;

      const start = yield* Fiber.join(startResult);
      const url = yield* Fiber.join(urlResult);
      assert.equal(failureReason(start), 'process_error');
      assert.equal(failureReason(url), 'process_error');
      assert.equal(
        Result.isFailure(start) ? start.failure.diagnostic.message : undefined,
        'Runtime lifecycle is stopping or stopped.',
      );
      assert.equal(
        Result.isFailure(url) ? url.failure.diagnostic.message : undefined,
        'Runtime lifecycle is stopping or stopped.',
      );
      assert.deepEqual(subject.signals, ['SIGTERM']);
      assert.equal((yield* snapshotOf(process)).state, 'connecting');
    }),
  );
});

test('intentional stop escalates an unresponsive child and remains bounded', async () => {
  const subject = harness({ exitOnTerm: false });
  await subject.run((process) =>
    Effect.gen(function* () {
      const started = yield* Effect.forkChild(process.start);
      yield* settle;
      ready(subject.child);
      yield* Fiber.join(started);
      const stopping = yield* Effect.forkChild(process.stop);
      yield* settle;
      assert.deepEqual(subject.signals, ['SIGTERM']);
      yield* TestClock.adjust(stopGrace);
      yield* Fiber.join(stopping);
      assert.deepEqual(subject.signals, ['SIGTERM', 'SIGKILL']);
      assert.notEqual((yield* snapshotOf(process)).state, 'failed');
    }),
  );
});

test('external health failure loads through, retains provenance, and always returns its URL', async () => {
  const secretUrl = 'https://user:secret@runtime.example.test/api?token=hidden';
  const subject = harness({
    target: { ownership: 'external', url: secretUrl },
    checkHealth: () => Effect.fail(new Error(`fetch ${secretUrl} failed`)),
  });
  await subject.run((process) =>
    Effect.gen(function* () {
      yield* process.start;
      const snapshot = yield* snapshotOf(process);
      assert.equal(snapshot.state, 'unreachable');
      assert.equal(snapshot.ownership, 'external');
      assert.equal(yield* process.url, secretUrl);
      assert.deepEqual(subject.logs, [
        {
          stream: 'stderr',
          payload: '[external] health check failed: fetch <external-runtime> failed\n',
        },
      ]);
      assert.equal(subject.spawns(), 0);
      assert.deepEqual(subject.signals, []);
    }),
  );
});

test('a health check that dies settles start like a failed check', async () => {
  const external = harness({
    target: { ownership: 'external', url: 'localhost:4100' },
    checkHealth: () => Effect.die(new TypeError('Invalid URL')),
  });
  await external.run((process) =>
    Effect.gen(function* () {
      const started = yield* Effect.forkChild(process.start);
      yield* settle;
      assert.ok(started.pollUnsafe(), 'start must settle');
      yield* Fiber.join(started);
      const snapshot = yield* snapshotOf(process);
      assert.equal(snapshot.state, 'unreachable');
      assert.equal(
        snapshot.state === 'unreachable' ? snapshot.reason : undefined,
        'external_health_check_failed',
      );
      assert.equal(yield* process.url, 'localhost:4100');
      assert.deepEqual(external.logs, [
        { stream: 'stderr', payload: '[external] health check failed: Invalid URL\n' },
      ]);
    }),
  );

  const managed = harness({ checkHealth: () => Effect.die(new Error('health crashed')) });
  await managed.run((process) =>
    Effect.gen(function* () {
      const result = yield* Effect.forkChild(Effect.result(process.start));
      yield* settle;
      ready(managed.child);
      const unhealthy = yield* Fiber.join(result);
      assert.equal(failureReason(unhealthy), 'health_check_failed');
      assert.equal(
        Result.isFailure(unhealthy) ? unhealthy.failure.diagnostic.message : undefined,
        'health crashed',
      );
      assert.equal((yield* snapshotOf(process)).state, 'failed');
      yield* settle;
      assert.deepEqual(managed.signals, ['SIGTERM']);
    }),
  );
});

test('a health check that throws instead of returning an effect is a failed check, never a stuck connecting', async () => {
  const throwingCheck = (): Effect.Effect<void, Error> => {
    throw new TypeError('Invalid URL');
  };
  const external = harness({
    target: { ownership: 'external', url: 'localhost:4100' },
    checkHealth: throwingCheck,
  });
  await external.run((process) =>
    Effect.gen(function* () {
      const started = yield* Effect.forkChild(Effect.exit(process.start));
      yield* settle;
      assert.ok(started.pollUnsafe(), 'start must settle');
      assert.ok(Exit.isSuccess(yield* Fiber.join(started)), 'an external runtime loads through');
      const snapshot = yield* snapshotOf(process);
      assert.equal(snapshot.state, 'unreachable');
      assert.deepEqual(external.logs, [
        { stream: 'stderr', payload: '[external] health check failed: Invalid URL\n' },
      ]);
    }),
  );

  const managed = harness({ checkHealth: throwingCheck });
  await managed.run((process) =>
    Effect.gen(function* () {
      const result = yield* Effect.forkChild(Effect.result(process.start));
      yield* settle;
      ready(managed.child);
      const unhealthy = yield* Fiber.join(result);
      assert.equal(failureReason(unhealthy), 'health_check_failed');
      assert.equal(
        Result.isFailure(unhealthy) ? unhealthy.failure.diagnostic.message : undefined,
        'Invalid URL',
      );
      assert.equal((yield* snapshotOf(process)).state, 'failed');
    }),
  );
});

test('a defect that escapes the run is still published and settles every waiter', async () => {
  const capture = makeLogCapture();
  const subject = harness({
    target: { ownership: 'external', url: 'https://user:secret@runtime.example.test' },
    checkHealth: () => Effect.fail(new Error('unreachable')),
    // The external failure path logs through the sink after publishing; a sink that throws there is a defect no
    // handler inside the run expects.
    log: () => {
      throw new Error('log sink closed for https://user:secret@runtime.example.test');
    },
  });
  await subject.run((process) =>
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(Effect.exit(process.start));
      yield* settle;
      assert.ok(first.pollUnsafe(), 'start must settle');
      assert.ok(Exit.isSuccess(yield* Fiber.join(first)));
      // Later callers get the same settled outcome instead of waiting forever.
      const second = yield* Effect.forkChild(Effect.exit(process.start));
      yield* settle;
      assert.ok(second.pollUnsafe(), 'a later start must settle too');
      const snapshot = yield* snapshotOf(process);
      assert.equal(snapshot.state, 'unreachable');
      assert.deepEqual(
        capture.lines.map((line) => [line.level, line.message]),
        [
          [
            'Error',
            'External runtime supervision ended unexpectedly: log sink closed for <external-runtime>',
          ],
        ],
      );
    }).pipe(Effect.provide(capture.layer)),
  );
});

test('a defect in the supervising fiber is published as a terminal failure, never a hang', async () => {
  const subject = harness();
  subject.child.stdout.on = (() => {
    throw new Error('listener rejected');
  }) as typeof subject.child.stdout.on;
  await subject.run((process) =>
    Effect.gen(function* () {
      const started = yield* Effect.forkChild(Effect.result(process.start));
      yield* settle;
      assert.ok(started.pollUnsafe(), 'start must settle');
      const result = yield* Fiber.join(started);
      assert.equal(failureReason(result), 'process_error');
      assert.equal(
        Result.isFailure(result) ? result.failure.diagnostic.message : undefined,
        'listener rejected',
      );
      const snapshot = yield* snapshotOf(process);
      assert.equal(snapshot.state === 'failed' ? snapshot.reason : undefined, 'process_error');
    }),
  );
});

test('a stop that outlives SIGKILL abandons observation and releases the child', async () => {
  const subject = harness({ exitOnTerm: false, exitOnKill: false });
  await subject.run((process) =>
    Effect.gen(function* () {
      const started = yield* Effect.forkChild(process.start);
      yield* settle;
      ready(subject.child);
      yield* Fiber.join(started);
      subject.child.stdout.write('partial');
      const stopping = yield* Effect.forkChild(process.stop);
      yield* settle;
      yield* TestClock.adjust(stopGrace);
      yield* settle;
      assert.deepEqual(subject.signals, ['SIGTERM', 'SIGKILL']);
      yield* TestClock.adjust('1 second');
      yield* Fiber.join(stopping);
      assert.deepEqual(
        subject.logs.slice(-2).map((record) => record.payload),
        ['Managed runtime did not report exit after SIGKILL; abandoning observation.\n', 'partial'],
      );
      assert.equal(subject.child.listenerCount('exit'), 0);
      assert.equal(subject.child.stdout.listenerCount('data'), 0);
    }),
  );
});

test('closing the layer scope stops a ready child', async () => {
  const subject = harness();
  await subject.run((process) =>
    Effect.gen(function* () {
      const started = yield* Effect.forkChild(process.start);
      yield* settle;
      ready(subject.child);
      yield* Fiber.join(started);
    }),
  );
  assert.deepEqual(subject.signals, ['SIGTERM']);
  assert.equal(subject.child.listenerCount('exit'), 0);
});
