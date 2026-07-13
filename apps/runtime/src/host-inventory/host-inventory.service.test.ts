import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, ManagedRuntime } from 'effect';

import { HostInventory, HostInventoryLive } from './host-inventory.service.js';
import {
  UserShell,
  type UserShellCommand,
  type UserShellCommandResult,
  type UserShellService,
} from './user-shell.service.js';

const success = (stdout: string, stderr = ''): UserShellCommandResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
  outputTruncated: false,
});

test('inventory begins pending and atomically publishes a whitelisted ready snapshot', async () => {
  const shell = fakeShell((input) => {
    if (input.command === 'env') {
      return success(
        'HOME=/home/dev\nPATH=/tools with spaces\nCODEX_HOME=/codex\nSECRET_TOKEN=nope\n',
      );
    }
    return success(`shell noise\n${input.command} 1.2.3\n`);
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const inventory = yield* HostInventory;
      assert.deepEqual(yield* inventory.getCached, { _tag: 'Pending' });
      const refreshed = yield* inventory.refresh;
      assert.deepEqual(refreshed.environment, {
        _tag: 'Available',
        values: { HOME: '/home/dev', PATH: '/tools with spaces', CODEX_HOME: '/codex' },
      });
      const cached = yield* inventory.getCached;
      assert.equal(cached['_tag'], 'Ready');
      if (cached['_tag'] === 'Ready') assert.deepEqual(cached.inventory, refreshed);
    }).pipe(Effect.provide(HostInventoryLive), Effect.provide(Layer.succeed(UserShell, shell))),
  );
});

test('inventory distinguishes missing, nonzero, malformed, and bounded output', async () => {
  const shell = fakeShell((input) => {
    if (input.command === 'env') return { ...success('HOME=/home/dev\n'), outputTruncated: true };
    if (input.command === 'pi') return { ...success('bad'), exitCode: 2, stderr: 'bad flag' };
    if (input.command === 'opencode') return success('no version here');
    if (input.command === 'claude') return { ...success(''), exitCode: 127, stderr: 'not found' };
    return { ...success('huge'), outputTruncated: true };
  });

  const snapshot = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* HostInventory).refresh;
    }).pipe(Effect.provide(HostInventoryLive), Effect.provide(Layer.succeed(UserShell, shell))),
  );
  assert.equal(snapshot.environment['_tag'], 'ProbeFailed');
  assert.deepEqual(tagAndReason(snapshot.harnesses.pi), ['ProbeFailed', 'nonzero_exit']);
  assert.deepEqual(tagAndReason(snapshot.harnesses.opencode), ['ProbeFailed', 'malformed_output']);
  assert.equal(snapshot.harnesses.claude['_tag'], 'Missing');
  assert.deepEqual(tagAndReason(snapshot.harnesses.codex), [
    'ProbeFailed',
    'output_limit_exceeded',
  ]);
});

test('concurrent refreshes are single-flight and keep the previous ready snapshot readable', async () => {
  let calls = 0;
  let generation = 1;
  const shell = fakeShell((input) =>
    Effect.gen(function* () {
      calls += 1;
      if (generation === 2) yield* Effect.sleep('30 millis');
      if (input.command === 'env') return success('HOME=/home/dev\n');
      return success(`${input.command} ${generation}.0.0`);
    }),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const inventory = yield* HostInventory;
      const firstPair = yield* Effect.all([inventory.refresh, inventory.refresh], {
        concurrency: 'unbounded',
      });
      assert.deepEqual(firstPair[0], firstPair[1]);
      assert.equal(calls, 5);

      generation = 2;
      const refreshFiber = yield* Effect.fork(inventory.refresh);
      yield* Effect.sleep('5 millis');
      const during = yield* inventory.getCached;
      assert.equal(during['_tag'], 'Ready');
      if (during['_tag'] === 'Ready' && during.inventory.harnesses.pi['_tag'] === 'Available') {
        assert.equal(during.inventory.harnesses.pi.version, 'pi 1.0.0');
      }
      yield* refreshFiber.await;
      const after = yield* inventory.getCached;
      assert.equal(after['_tag'], 'Ready');
      if (after['_tag'] === 'Ready' && after.inventory.harnesses.pi['_tag'] === 'Available') {
        assert.equal(after.inventory.harnesses.pi.version, 'pi 2.0.0');
      }
    }).pipe(Effect.provide(HostInventoryLive), Effect.provide(Layer.succeed(UserShell, shell))),
  );
});

test('managed runtime disposal interrupts an in-flight inventory refresh', async () => {
  let interruptions = 0;
  const shell = fakeShell(() =>
    Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interruptions++))),
  );
  const runtime = ManagedRuntime.make(
    HostInventoryLive.pipe(Layer.provide(Layer.succeed(UserShell, shell))),
  );
  await runtime.runPromise(Effect.flatMap(HostInventory, (inventory) => inventory.startRefresh));
  await runtime.dispose();
  assert.ok(interruptions > 0);
});

function fakeShell(
  run: (input: UserShellCommand) => UserShellCommandResult | Effect.Effect<UserShellCommandResult>,
): UserShellService {
  return {
    baseEnvironment: { HOME: '/fallback', PATH: '/fallback/bin' },
    run: (input) =>
      Effect.suspend(() => {
        const result = run(input);
        return Effect.isEffect(result) ? result : Effect.succeed(result);
      }),
  };
}

function tagAndReason(value: { readonly _tag: string; readonly reason?: string }) {
  return [value['_tag'], value.reason];
}
