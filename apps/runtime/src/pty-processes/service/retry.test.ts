import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { makePtyRetryScheduler } from './retry.js';

// Deferred terminal writes outlive the call that schedules them, so the thing
// under test here is ownership: the PTY service scope decides when this work
// stops, and it must stop while the repository is still open.

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test('a scheduled job runs after its delay', async () => {
  const scheduler = makePtyRetryScheduler({ delayMs: 0 });
  let ran = 0;

  scheduler.schedule(
    'killed ptyProcessId=1',
    Effect.sync(() => {
      ran += 1;
    }),
  );
  await delay(5);

  assert.equal(ran, 1);
  await Effect.runPromise(scheduler.shutdown);
});

test('shutdown runs queued work instead of dropping it', async () => {
  const scheduler = makePtyRetryScheduler({ delayMs: 60_000 });
  let ran = 0;

  scheduler.schedule(
    'killed ptyProcessId=1',
    Effect.sync(() => {
      ran += 1;
    }),
  );
  await Effect.runPromise(scheduler.shutdown);

  // The delay was backoff, not a reason to discard the write: shutdown is the
  // last moment the repository is open, so the queued attempt happens here.
  assert.equal(ran, 1);
});

test('a queued job that fails during shutdown is abandoned out loud', async () => {
  const scheduler = makePtyRetryScheduler({ delayMs: 60_000 });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => {
    warnings.push(String(message));
  };
  let attempts = 0;
  const job: Effect.Effect<void> = Effect.sync(() => {
    attempts += 1;
    // Still failing, so it asks for another attempt — which no longer exists.
    scheduler.schedule('killed ptyProcessId=1', job);
  });

  scheduler.schedule('killed ptyProcessId=1', job);
  try {
    await Effect.runPromise(scheduler.shutdown);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(attempts, 1);
  assert.deepEqual(warnings, [
    '[runtime] Abandoning PTY persistence retry after shutdown killed ptyProcessId=1',
  ]);
});

test('shutdown waits for an in-flight job and refuses the retry it schedules', async () => {
  const scheduler = makePtyRetryScheduler({ delayMs: 0 });
  let started = 0;
  let finished = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job: Effect.Effect<void> = Effect.promise(async () => {
    started += 1;
    await gate;
    finished += 1;
    // A job that failed again asks for another attempt. Past shutdown there is
    // nobody left to serve it.
    scheduler.schedule('killed ptyProcessId=1', job);
  });

  scheduler.schedule('killed ptyProcessId=1', job);
  await delay(5);
  assert.equal(started, 1);

  const shutdown = Effect.runPromise(scheduler.shutdown);
  release();
  await shutdown;
  await delay(20);

  // The write that was already touching the database completed before the scope
  // released it; the follow-up it asked for never ran.
  assert.equal(finished, 1);
  assert.equal(started, 1);
});
