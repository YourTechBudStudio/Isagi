import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { InternalEvents } from '../platform/events/index.js';
import { ProcessTokens } from './process-tokens.js';

const run = <A, E>(effect: Effect.Effect<A, E, ProcessTokens | InternalEvents>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(ProcessTokens.layerNoDeps.pipe(Layer.provideMerge(InternalEvents.layer))),
    ),
  );

/** Lets the forked release consumer drain what was published. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
});

test('issue is idempotent per holder and distinct across holders', () =>
  run(
    Effect.gen(function* () {
      const tokens = yield* ProcessTokens;
      const first = yield* tokens.issue({ _tag: 'pty', ptyProcessId: 7 });
      assert.match(first, /^[0-9a-f]{64}$/);
      assert.equal(yield* tokens.issue({ _tag: 'pty', ptyProcessId: 7 }), first);
      const sdk = yield* tokens.issue({ _tag: 'sdk', executionId: '7' });
      assert.notEqual(sdk, first);
      assert.equal(tokens.isLive(first), true);
      assert.equal(tokens.isLive(sdk), true);
      assert.equal(tokens.isLive(''), false);
      assert.equal(tokens.isLive('not-a-token'), false);
    }),
  ));

test('a released token is refused, release is idempotent and an unknown holder is a no-op', () =>
  run(
    Effect.gen(function* () {
      const tokens = yield* ProcessTokens;
      const holder = { _tag: 'sdk', executionId: 'voice-1' } as const;
      const token = yield* tokens.issue(holder);
      yield* tokens.release(holder);
      assert.equal(tokens.isLive(token), false);
      yield* tokens.release(holder);
      yield* tokens.release({ _tag: 'pty', ptyProcessId: 404 });
      const next = yield* tokens.issue(holder);
      assert.notEqual(next, token);
      assert.equal(tokens.isLive(next), true);
    }),
  ));

test('PTY exited, killed and failed events release that PTY’s token only', () =>
  run(
    Effect.gen(function* () {
      const tokens = yield* ProcessTokens;
      const events = yield* InternalEvents;
      const exited = yield* tokens.issue({ _tag: 'pty', ptyProcessId: 1 });
      const killed = yield* tokens.issue({ _tag: 'pty', ptyProcessId: 2 });
      const failed = yield* tokens.issue({ _tag: 'pty', ptyProcessId: 3 });
      const running = yield* tokens.issue({ _tag: 'pty', ptyProcessId: 4 });
      const sdk = yield* tokens.issue({ _tag: 'sdk', executionId: '1' });

      yield* events.publish({
        type: 'pty_process_exited',
        ptyProcessId: 1,
        status: 'exited',
        exitCode: 0,
        signal: null,
      });
      yield* events.publish({
        type: 'pty_process_killed',
        ptyProcessId: 2,
        status: 'killed',
        statusReason: null,
      });
      // A launch that fails after allocation is published as failed through the same chokepoint.
      yield* events.publish({
        type: 'pty_process_failed',
        ptyProcessId: 3,
        status: 'failed',
        statusReason: 'spawn failed',
      });
      yield* events.publish({ type: 'pty_process_started', ptyProcessId: 4, status: 'running' });
      yield* settle;

      assert.equal(tokens.isLive(exited), false);
      assert.equal(tokens.isLive(killed), false);
      assert.equal(tokens.isLive(failed), false);
      assert.equal(tokens.isLive(running), true);
      assert.equal(tokens.isLive(sdk), true);
    }),
  ));
