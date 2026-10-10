import assert from 'node:assert/strict';
import test from 'node:test';

import { Deferred, Effect, Exit, Fiber, Ref, Scope } from 'effect';
import { TestClock } from 'effect/testing';

import { makeLogCapture, runWithTestClock } from '@isagi/testing';

import { makePersistenceRetry } from './retry.js';

// Deferred terminal writes outlive the call that submits them, so the thing
// under test here is ownership: the PTY service scope decides when this work
// stops, and it must stop while the repository is still open. Time is the
// TestClock's; the default backoff is one second.

const failingUntil = (attempts: Ref.Ref<number>, succeedOn: number) =>
  Ref.updateAndGet(attempts, (n) => n + 1).pipe(
    Effect.flatMap((n) => (n >= succeedOn ? Effect.void : Effect.fail(new Error('SQLITE_BUSY')))),
  );

test('a submitted attempt runs after its delay', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const retry = yield* makePersistenceRetry;
      const attempts = yield* Ref.make(0);

      yield* retry.submit('killed ptyProcessId=1', failingUntil(attempts, 1));
      yield* TestClock.adjust('999 millis');
      assert.equal(yield* Ref.get(attempts), 0);
      yield* TestClock.adjust('1 millis');
      assert.equal(yield* Ref.get(attempts), 1);

      // Settled: nothing is retried again.
      yield* TestClock.adjust('1 minute');
      assert.equal(yield* Ref.get(attempts), 1);
    }),
  ));

test('a failed attempt is logged and retried every delay until it succeeds', () => {
  const logs = makeLogCapture();
  return runWithTestClock(
    Effect.gen(function* () {
      const retry = yield* makePersistenceRetry;
      const attempts = yield* Ref.make(0);

      yield* retry.submit('exit ptyProcessId=2', failingUntil(attempts, 3));
      yield* TestClock.adjust('10 seconds');

      assert.equal(yield* Ref.get(attempts), 3);
      assert.deepEqual(
        logs.lines.map((line) => [line.level, line.message, line.annotations.label]),
        [
          ['Error', 'PTY persistence retry failed', 'exit ptyProcessId=2'],
          ['Error', 'PTY persistence retry failed', 'exit ptyProcessId=2'],
        ],
      );
    }).pipe(Effect.provide(logs.layer)),
  );
});

test('closing the scope runs a waiting retry instead of dropping it', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const retry = yield* makePersistenceRetry;
          yield* retry.submit('killed ptyProcessId=1', failingUntil(attempts, 1));
        }),
      );

      // The delay was backoff, not a reason to discard the write: scope close is
      // the last moment the repository is open, so the attempt happens there,
      // without the clock moving.
      assert.equal(yield* Ref.get(attempts), 1);
    }),
  ));

test('pending launch retries are cancelled when the scope closes', () => {
  const logs = makeLogCapture();
  return runWithTestClock(
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const retry = yield* makePersistenceRetry;
          yield* retry.submit('exit ptyProcessId=3', failingUntil(attempts, Infinity));
          yield* TestClock.adjust('1 second');
          assert.equal(yield* Ref.get(attempts), 1);
        }),
      );

      // Scope close cut the pending backoff short for one final attempt, which
      // failed, so the retry was abandoned out loud.
      assert.equal(yield* Ref.get(attempts), 2);
      assert.deepEqual(
        logs.lines.map((line) => [line.level, line.message]),
        [
          ['Error', 'PTY persistence retry failed'],
          ['Error', 'PTY persistence retry failed'],
          ['Warn', 'Abandoning PTY persistence retry after shutdown'],
        ],
      );

      // Nothing runs after the scope closed, however far the clock moves.
      yield* TestClock.adjust('1 hour');
      assert.equal(yield* Ref.get(attempts), 2);
    }).pipe(Effect.provide(logs.layer)),
  );
});

test('scope close waits for an in-flight attempt and abandons it when it fails', () => {
  const logs = makeLogCapture();
  return runWithTestClock(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const retry = yield* makePersistenceRetry.pipe(Scope.provide(scope));
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const attempts = yield* Ref.make(0);
      const attempt = Ref.update(attempts, (n) => n + 1).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(gate)),
        Effect.andThen(Effect.fail(new Error('SQLITE_BUSY'))),
      );

      yield* retry.submit('killed ptyProcessId=4', attempt);
      yield* TestClock.adjust('1 second');
      yield* Deferred.await(entered);

      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* Effect.yieldNow;
      // The write that is already touching the database is waited for.
      assert.equal(closing.pollUnsafe(), undefined);

      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(closing);

      // It failed while draining, so it gets no further attempt.
      assert.equal(yield* Ref.get(attempts), 1);
      assert.deepEqual(
        logs.lines.at(-1)?.message,
        'Abandoning PTY persistence retry after shutdown',
      );
    }).pipe(Effect.provide(logs.layer)),
  );
});

test('a retry submitted after scope close is abandoned out loud and never attempted', () => {
  const logs = makeLogCapture();
  return runWithTestClock(
    Effect.gen(function* () {
      const retry = yield* Effect.scoped(makePersistenceRetry);
      const attempts = yield* Ref.make(0);

      yield* retry.submit('killed ptyProcessId=5', failingUntil(attempts, 1));
      yield* TestClock.adjust('1 minute');

      assert.equal(yield* Ref.get(attempts), 0);
      assert.deepEqual(
        logs.lines.map((line) => [line.level, line.message, line.annotations.label]),
        [['Warn', 'Abandoning PTY persistence retry after shutdown', 'killed ptyProcessId=5']],
      );
    }).pipe(Effect.provide(logs.layer)),
  );
});
