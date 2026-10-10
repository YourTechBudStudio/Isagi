import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Cause, Effect, References } from 'effect';

import { runScoped } from './effect.js';
import { makeLogCapture } from './logs.js';

test('captures level, joined message and annotations of each log line', async () => {
  const capture = makeLogCapture();
  await runScoped(
    Effect.gen(function* () {
      yield* Effect.logInfo('session gc', 'swept', 3);
      yield* Effect.logWarning('tick failed').pipe(Effect.annotateLogs({ module: 'session-gc' }));
    }).pipe(Effect.provide(capture.layer)),
  );
  assert.deepEqual(capture.lines, [
    { level: 'Info', message: 'session gc swept 3', annotations: {}, cause: undefined },
    {
      level: 'Warn',
      message: 'tick failed',
      annotations: { module: 'session-gc' },
      cause: undefined,
    },
  ]);
});

test('records the pretty cause attached to a log call', async () => {
  const capture = makeLogCapture();
  await runScoped(
    Effect.logError('launch failed', Cause.fail(new Error('spawn ENOENT'))).pipe(
      Effect.provide(capture.layer),
    ),
  );
  assert.equal(capture.lines.length, 1);
  assert.equal(capture.lines[0]?.level, 'Error');
  assert.match(capture.lines[0]?.cause ?? '', /spawn ENOENT/);
});

test('drops Debug lines unless the minimum log level allows them', async () => {
  const capture = makeLogCapture();
  await runScoped(Effect.logDebug('hidden').pipe(Effect.provide(capture.layer)));
  assert.deepEqual(capture.lines, []);
  await runScoped(
    Effect.logDebug('shown').pipe(
      Effect.provide(capture.layer),
      Effect.provideService(References.MinimumLogLevel, 'Debug'),
    ),
  );
  assert.deepEqual(
    capture.lines.map(({ level, message }) => ({ level, message })),
    [{ level: 'Debug', message: 'shown' }],
  );
});
