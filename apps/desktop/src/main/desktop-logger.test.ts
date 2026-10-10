import assert from 'node:assert/strict';
import test from 'node:test';

import { Console, Effect, Logger, Tracer } from 'effect';

import { runScoped } from '@isagi/testing';

import { desktopConsoleLogger, DesktopLogger } from './desktop-logger.js';

/** A console that records which method each line went to, with its arguments. */
function recordingConsole() {
  const calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: readonly unknown[]) =>
      void calls.push({ method, args });
  const console = Object.assign(Object.create(globalThis.console) as Console.Console, {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  });
  return { calls, console };
}

const logged = <A, E>(effect: Effect.Effect<A, E>) => {
  const { calls, console } = recordingConsole();
  return runScoped(
    effect.pipe(
      Effect.provide(Logger.layer([desktopConsoleLogger])),
      Effect.provideService(Console.Console, console),
    ),
  ).then(() => calls);
};

test('desktop log lines keep the [desktop] prefix and the info/warn/error console split', async () => {
  const calls = await logged(
    Effect.gen(function* () {
      yield* Effect.logInfo('runtime stage /stage');
      yield* Effect.logWarning('Updater diagnostics could not be persisted.');
      yield* Effect.logError('Managed runtime failed', { reason: 'readiness_timeout' });
    }),
  );
  assert.deepEqual(calls, [
    { method: 'info', args: ['[desktop] runtime stage /stage'] },
    { method: 'warn', args: ['[desktop] Updater diagnostics could not be persisted.'] },
    {
      method: 'error',
      args: ['[desktop] Managed runtime failed', { reason: 'readiness_timeout' }],
    },
  ]);
});

test('desktop log lines carry annotations and the attached cause', async () => {
  const failure = new Error('stage missing');
  const calls = await logged(
    Effect.fail(failure).pipe(
      Effect.catchCause((cause) => Effect.logError('Managed runtime failed to start', cause)),
      Effect.annotateLogs({ ownership: 'managed', attempt: 2 }),
    ),
  );
  assert.equal(calls.length, 1);
  const [first, ...rest] = calls[0]!.args;
  assert.equal(calls[0]!.method, 'error');
  assert.equal(first, '[desktop] Managed runtime failed to start');
  assert.deepEqual(rest.slice(0, 2), ['ownership=managed', 'attempt=2']);
  assert.match(String(rest[2]), /stage missing/u);
  assert.equal(rest.length, 3);
});

test('debug lines are below the default level and stay silent', async () => {
  const calls = await logged(Effect.logDebug('phase trace'));
  assert.deepEqual(calls, []);
});

test('the desktop logger set keeps span events', async () => {
  const { console } = recordingConsole();
  const events: string[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const event = span.event.bind(span);
      span.event = (name, startTime, attributes) => {
        events.push(name);
        event(name, startTime, attributes);
      };
      return span;
    },
  });
  await runScoped(
    Effect.logInfo('inside a span').pipe(
      Effect.withSpan('desktop.test'),
      Effect.provide(DesktopLogger),
      Effect.provideService(Console.Console, console),
      Effect.withTracer(tracer),
    ),
  );
  assert.deepEqual(events, ['inside a span']);
});
