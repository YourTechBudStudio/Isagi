import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Fiber, Layer, ManagedRuntime } from 'effect';

import {
  UserShell,
  type UserShellCommand,
  type UserShellCommandResult,
} from '../../platform/process/index.js';
import { HostInventory } from './service.js';

const success = (stdout: string, stderr = ''): UserShellCommandResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
  outputTruncated: false,
});

test('inventory begins pending and atomically publishes a whitelisted ready snapshot', async () => {
  const shell = fakeShell((input) => success(`shell noise\n${input.command} 1.2.3\n`), {
    _tag: 'Available',
    values: {
      HOME: '/home/dev',
      PATH: '/tools with spaces',
      CODEX_HOME: '/codex',
      SECRET_TOKEN: 'nope',
    },
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
    }).pipe(Effect.provide(HostInventory.layer), Effect.provide(Layer.succeed(UserShell, shell))),
  );
});

test('inventory distinguishes missing, nonzero, malformed, and bounded output', async () => {
  const shell = fakeShell(
    (input) => {
      if (input.command === 'pi') return { ...success('bad'), exitCode: 2, stderr: 'bad flag' };
      if (input.command === 'opencode') return success('no version here');
      if (input.command === 'claude') return { ...success(''), exitCode: 127, stderr: 'not found' };
      return { ...success('huge'), outputTruncated: true };
    },
    {
      _tag: 'ProbeFailed',
      values: { HOME: '/fallback', PATH: '/fallback/bin' },
      diagnostic: 'Environment output exceeded its limit.',
    },
  );

  const snapshot = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* HostInventory).refresh;
    }).pipe(Effect.provide(HostInventory.layer), Effect.provide(Layer.succeed(UserShell, shell))),
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
      assert.equal(calls, 4);

      generation = 2;
      const refreshFiber = yield* Effect.forkChild(inventory.refresh);
      yield* Effect.sleep('5 millis');
      const during = yield* inventory.getCached;
      assert.equal(during['_tag'], 'Ready');
      if (during['_tag'] === 'Ready' && during.inventory.harnesses.pi['_tag'] === 'Available') {
        assert.equal(during.inventory.harnesses.pi.version, 'pi 1.0.0');
      }
      yield* Fiber.await(refreshFiber);
      const after = yield* inventory.getCached;
      assert.equal(after['_tag'], 'Ready');
      if (after['_tag'] === 'Ready' && after.inventory.harnesses.pi['_tag'] === 'Available') {
        assert.equal(after.inventory.harnesses.pi.version, 'pi 2.0.0');
      }
    }).pipe(Effect.provide(HostInventory.layer), Effect.provide(Layer.succeed(UserShell, shell))),
  );
});

test('managed runtime disposal interrupts an in-flight inventory refresh', async () => {
  let interruptions = 0;
  const probeStarted = Promise.withResolvers<void>();
  const shell = fakeShell(() =>
    Effect.sync(() => probeStarted.resolve()).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => interruptions++)),
    ),
  );
  const runtime = ManagedRuntime.make(
    HostInventory.layer.pipe(Layer.provide(Layer.succeed(UserShell, shell))),
  );
  await runtime.runPromise(Effect.flatMap(HostInventory, (inventory) => inventory.startRefresh));
  // `startRefresh` only forks the refresh; v4 starts that fiber on a later scheduler tick, so wait
  // until a probe is actually in flight before disposing.
  await probeStarted.promise;
  await runtime.dispose();
  assert.ok(interruptions > 0);
});

function fakeShell(
  run: (input: UserShellCommand) => UserShellCommandResult | Effect.Effect<UserShellCommandResult>,
  environment: UserShell['Service']['environment'] = {
    _tag: 'Available',
    values: { HOME: '/fallback', PATH: '/fallback/bin' },
  },
): UserShell['Service'] {
  return {
    environment,
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
