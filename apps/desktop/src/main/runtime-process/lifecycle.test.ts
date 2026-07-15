import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { Effect, Either } from 'effect';

import { RuntimeLifecycle, RuntimeLifecycleFailure, type RuntimeTarget } from './lifecycle.js';
import type {
  RuntimeChildProcess,
  RuntimeProcessAdapter,
  RuntimeSpawnSpecification,
} from './process-adapter.js';

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

function managedTarget(): RuntimeTarget {
  return {
    ownership: 'managed',
    prepare: () => ({
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
    readonly checkHealth?: (url: string) => Promise<void>;
    readonly spawnError?: Error;
    readonly readinessTimeoutMs?: number;
    readonly exitOnTerm?: boolean;
  } = {},
) {
  const child = new FakeChild();
  const signals: NodeJS.Signals[] = [];
  const logs: { stream: 'stdout' | 'stderr'; payload: string }[] = [];
  let spawns = 0;
  const adapter: RuntimeProcessAdapter = {
    spawn: (_specification: RuntimeSpawnSpecification) => {
      spawns += 1;
      if (options.spawnError) throw options.spawnError;
      return child as unknown as RuntimeChildProcess;
    },
    signal: (_child, signal) => {
      signals.push(signal);
      if ((signal === 'SIGTERM' && options.exitOnTerm !== false) || signal === 'SIGKILL') {
        queueMicrotask(() => child.exit(0, signal === 'SIGKILL' ? 'SIGKILL' : null));
      }
    },
  };
  const lifecycle = new RuntimeLifecycle(options.target ?? managedTarget(), {
    processAdapter: adapter,
    checkHealth: options.checkHealth ?? (() => Promise.resolve()),
    log: (record) => logs.push(record),
    readinessTimeoutMs: options.readinessTimeoutMs ?? 100,
    stopGraceMs: 20,
  });
  return { child, lifecycle, logs, signals, spawns: () => spawns };
}

function ready(child: FakeChild, port = 43129) {
  child.stdout.write(`ISAGI_RUNTIME_RE`);
  child.stdout.write(`ADY {"url":"http://127.0.0.1:${port}"}\n`);
}

test('concurrent URL callers share one spawn and readiness plus health gate', async () => {
  let releaseHealth!: () => void;
  const health = new Promise<void>((resolve) => {
    releaseHealth = resolve;
  });
  const subject = harness({ checkHealth: () => health });
  const first = Effect.runPromise(subject.lifecycle.getUrl());
  const second = Effect.runPromise(subject.lifecycle.getUrl());
  ready(subject.child);
  assert.equal(subject.spawns(), 1);
  assert.equal(subject.lifecycle.snapshot.state, 'connecting');
  releaseHealth();
  assert.equal(await first, 'http://127.0.0.1:43129/');
  assert.equal(await second, 'http://127.0.0.1:43129/');
  assert.equal(subject.lifecycle.snapshot.state, 'ready');
  await Effect.runPromise(subject.lifecycle.stop());
});

test('malformed readiness is a stored terminal failure', async () => {
  const subject = harness();
  const result = Effect.runPromise(Effect.either(subject.lifecycle.start()));
  subject.child.stdout.write('ISAGI_RUNTIME_READY {"url":42}\n');
  const either = await result;
  assert.equal(Either.isLeft(either) ? either.left.reason : undefined, 'readiness_malformed');
  assert.equal(subject.lifecycle.snapshot.state, 'failed');
  const repeated = await Effect.runPromise(Effect.either(subject.lifecycle.getUrl()));
  assert.equal(Either.isLeft(repeated) ? repeated.left.reason : undefined, 'readiness_malformed');
});

test('readiness timeout is terminal and signals the child', async () => {
  const subject = harness({ readinessTimeoutMs: 5 });
  const result = await Effect.runPromise(Effect.either(subject.lifecycle.start()));
  assert.equal(Either.isLeft(result) ? result.left.reason : undefined, 'readiness_timeout');
  assert.deepEqual(subject.signals, ['SIGTERM']);
});

test('spawn failure and pre-ready exit remain distinguishable', async () => {
  const spawnFailure = harness({ spawnError: new Error('spawn denied') });
  const spawnResult = await Effect.runPromise(Effect.either(spawnFailure.lifecycle.start()));
  assert.equal(Either.isLeft(spawnResult) ? spawnResult.left.reason : undefined, 'spawn_failed');

  const earlyExit = harness();
  const exitResult = Effect.runPromise(Effect.either(earlyExit.lifecycle.start()));
  earlyExit.child.exit(7, null);
  const exited = await exitResult;
  assert.equal(Either.isLeft(exited) ? exited.left.reason : undefined, 'exited_before_ready');
  assert.equal(
    earlyExit.lifecycle.snapshot.state === 'failed'
      ? earlyExit.lifecycle.snapshot.diagnostic?.exitCode
      : undefined,
    7,
  );
});

test('stage preparation and post-ready process errors retain their stable reasons', async () => {
  const stageFailure = harness({
    target: {
      ownership: 'managed',
      prepare: () => {
        throw new RuntimeLifecycleFailure({
          reason: 'stage_invalid',
          diagnostic: { message: 'metadata mismatch' },
        });
      },
    },
  });
  const stageResult = await Effect.runPromise(Effect.either(stageFailure.lifecycle.start()));
  assert.equal(Either.isLeft(stageResult) ? stageResult.left.reason : undefined, 'stage_invalid');

  const processFailure = harness();
  const started = Effect.runPromise(processFailure.lifecycle.start());
  ready(processFailure.child);
  await started;
  processFailure.child.fail(new Error('pipe failed'));
  assert.equal(
    processFailure.lifecycle.snapshot.state === 'failed'
      ? processFailure.lifecycle.snapshot.reason
      : undefined,
    'process_error',
  );
});

test('health failure and post-ready exit remain distinguishable', async () => {
  const healthFailure = harness({ checkHealth: () => Promise.reject(new Error('health bad')) });
  const healthResult = Effect.runPromise(Effect.either(healthFailure.lifecycle.start()));
  ready(healthFailure.child);
  const unhealthy = await healthResult;
  assert.equal(Either.isLeft(unhealthy) ? unhealthy.left.reason : undefined, 'health_check_failed');

  const postReady = harness();
  const started = Effect.runPromise(postReady.lifecycle.start());
  ready(postReady.child);
  await started;
  postReady.child.exit(null, 'SIGABRT');
  assert.equal(postReady.lifecycle.snapshot.state, 'failed');
  assert.equal(
    postReady.lifecycle.snapshot.state === 'failed'
      ? postReady.lifecycle.snapshot.reason
      : undefined,
    'exited_after_ready',
  );
});

test('intentional repeated stop is idempotent and never publishes failure', async () => {
  const subject = harness();
  const snapshots = [subject.lifecycle.snapshot];
  subject.lifecycle.subscribe((snapshot) => snapshots.push(snapshot));
  const started = Effect.runPromise(subject.lifecycle.start());
  ready(subject.child);
  await started;
  subject.child.stderr.write('\u001b[31mfinal diagnostic\u001b[0m');
  await Promise.all([
    Effect.runPromise(subject.lifecycle.stop()),
    Effect.runPromise(subject.lifecycle.stop()),
  ]);
  assert.deepEqual(subject.signals, ['SIGTERM']);
  assert.equal(
    snapshots.some((snapshot) => snapshot.state === 'failed'),
    false,
  );
  assert.equal(subject.logs.at(-1)?.payload, '\u001b[31mfinal diagnostic\u001b[0m');
});

test('intentional stop during startup settles pending start and URL waiters', async () => {
  const subject = harness();
  const startResult = Effect.runPromise(Effect.either(subject.lifecycle.start()));
  const urlResult = Effect.runPromise(Effect.either(subject.lifecycle.getUrl()));

  await Effect.runPromise(subject.lifecycle.stop());

  const [start, url] = await Promise.all([startResult, urlResult]);
  assert.equal(Either.isLeft(start) ? start.left.reason : undefined, 'process_error');
  assert.equal(Either.isLeft(url) ? url.left.reason : undefined, 'process_error');
  assert.equal(
    Either.isLeft(start) ? start.left.diagnostic.message : undefined,
    'Runtime lifecycle is stopping or stopped.',
  );
  assert.equal(
    Either.isLeft(url) ? url.left.diagnostic.message : undefined,
    'Runtime lifecycle is stopping or stopped.',
  );
  assert.deepEqual(subject.signals, ['SIGTERM']);
});

test('intentional stop escalates an unresponsive child and remains bounded', async () => {
  const subject = harness({ exitOnTerm: false });
  const started = Effect.runPromise(subject.lifecycle.start());
  ready(subject.child);
  await started;
  await Effect.runPromise(subject.lifecycle.stop());
  assert.deepEqual(subject.signals, ['SIGTERM', 'SIGKILL']);
  assert.notEqual(subject.lifecycle.snapshot.state, 'failed');
});

test('external health failure loads through, retains provenance, and always returns its URL', async () => {
  const secretUrl = 'https://user:secret@runtime.example.test/api?token=hidden';
  const subject = harness({
    target: { ownership: 'external', url: secretUrl },
    checkHealth: () => Promise.reject(new Error(`fetch ${secretUrl} failed`)),
  });
  await Effect.runPromise(subject.lifecycle.start());
  assert.equal(subject.lifecycle.snapshot.state, 'unreachable');
  assert.equal(subject.lifecycle.snapshot.ownership, 'external');
  assert.equal(await Effect.runPromise(subject.lifecycle.getUrl()), secretUrl);
  assert.equal(
    subject.logs.some((record) => record.payload.includes('secret')),
    false,
  );
  assert.equal(subject.spawns(), 0);
  assert.deepEqual(subject.signals, []);
});
