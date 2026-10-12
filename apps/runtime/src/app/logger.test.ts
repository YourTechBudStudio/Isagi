import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Cause, ConfigProvider, Console, Effect, Exit, Logger } from 'effect';

import { InvalidRuntimeSetting, RuntimeLogger, RuntimeSettings } from './logger.js';

const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

const readSettings = (env: Record<string, string>) =>
  Effect.runPromiseExit(RuntimeSettings.pipe(withEnv(env)));

const settingsFor = async (env: Record<string, string>) => {
  const exit = await readSettings(env);
  assert.ok(Exit.isSuccess(exit), `expected settings for ${JSON.stringify(env)}`);
  return exit.value;
};

const failureFor = async (env: Record<string, string>) => {
  const exit = await readSettings(env);
  assert.ok(Exit.isFailure(exit), `expected a failure for ${JSON.stringify(env)}`);
  return Cause.squash(exit.cause);
};

describe('RuntimeSettings', () => {
  test('unset HOST and PORT mean loopback and any free port', async () => {
    assert.deepEqual(await settingsFor({}), { host: '127.0.0.1', port: 0, debug: false });
  });

  test('an empty HOST or PORT is treated as unset', async () => {
    assert.deepEqual(await settingsFor({ HOST: '', PORT: '' }), {
      host: '127.0.0.1',
      port: 0,
      debug: false,
    });
  });

  test('HOST and PORT are read from the environment', async () => {
    assert.deepEqual(await settingsFor({ HOST: '0.0.0.0', PORT: '8080' }), {
      host: '0.0.0.0',
      port: 8080,
      debug: false,
    });
  });

  test('PORT keeps parseInt semantics: a numeric prefix is the port', async () => {
    assert.equal((await settingsFor({ PORT: '8080abc' })).port, 8080);
    assert.equal((await settingsFor({ PORT: '65535' })).port, 65_535);
    assert.equal((await settingsFor({ PORT: '0' })).port, 0);
  });

  test('a PORT that is not a number fails with the startup message', async () => {
    const failure = await failureFor({ PORT: 'x' });
    assert.ok(failure instanceof InvalidRuntimeSetting);
    assert.equal(failure.message, 'Invalid PORT value: x');
  });

  test('a PORT outside 0-65535 fails with the startup message', async () => {
    for (const value of ['70000', '65536', '-1']) {
      const failure = await failureFor({ PORT: value });
      assert.ok(failure instanceof InvalidRuntimeSetting, `expected ${value} to be rejected`);
      assert.equal(failure.message, `Invalid PORT value: ${value}`);
    }
  });

  test('ISAGI_RUNTIME_DEBUG is on for exactly 1, true and yes', async () => {
    for (const value of ['1', 'true', 'yes']) {
      assert.equal((await settingsFor({ ISAGI_RUNTIME_DEBUG: value })).debug, true, value);
    }
    for (const value of ['', '0', 'false', 'on', 'TRUE', 'debug']) {
      assert.equal((await settingsFor({ ISAGI_RUNTIME_DEBUG: value })).debug, false, value);
    }
  });
});

describe('RuntimeLogger', () => {
  /** Runs `program` under `RuntimeLogger.layer` with `env`, recording what reaches each console method. */
  const logWith = async (env: Record<string, string>, program: Effect.Effect<void>) => {
    const calls: Array<{ readonly method: string; readonly line: string }> = [];
    const record =
      (method: string) =>
      (...args: ReadonlyArray<unknown>) => {
        calls.push({ method, line: args.map(String).join(' ') });
      };
    const console: Console.Console = {
      ...globalThis.console,
      debug: record('debug'),
      info: record('info'),
      log: record('log'),
      warn: record('warn'),
      error: record('error'),
      trace: record('trace'),
    };
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(RuntimeLogger.layer),
          withEnv(env),
          Effect.provideService(Console.Console, console),
        ),
      ),
    );
    return calls;
  };

  const program = Effect.gen(function* () {
    yield* Effect.logDebug('Diagnostic phase completed').pipe(
      Effect.annotateLogs({ phase: 'pty.gc', elapsedMs: 3 }),
    );
    yield* Effect.logInfo('PTY launch starting').pipe(Effect.annotateLogs({ ptyProcessId: 4 }));
    yield* Effect.logWarning('PTY status polling failed');
    yield* Effect.logError(
      'Runtime event websocket failed',
      Cause.fail(new Error('line one\nline two')),
    );
  });

  test('Debug entries are hidden unless ISAGI_RUNTIME_DEBUG enables them', async () => {
    const hidden = await logWith({}, program);
    assert.deepEqual(
      hidden.map((call) => call.method),
      ['info', 'warn', 'error'],
    );

    const shown = await logWith({ ISAGI_RUNTIME_DEBUG: '1' }, program);
    assert.deepEqual(
      shown.map((call) => call.method),
      ['debug', 'info', 'warn', 'error'],
    );
    assert.match(
      shown[0]!.line,
      /level=DEBUG .*message="Diagnostic phase completed" phase=pty\.gc elapsedMs=3/,
    );
  });

  test('entries are single logfmt lines routed by level: Info to stdout methods, Warn and Error to stderr methods', async () => {
    const calls = await logWith({}, program);
    assert.match(calls[0]!.line, /level=INFO .*message="PTY launch starting" ptyProcessId=4/);
    assert.match(calls[1]!.line, /level=WARN .*message="PTY status polling failed"/);
    assert.match(calls[2]!.line, /level=ERROR .*message="Runtime event websocket failed"/);
    for (const call of calls)
      assert.ok(!call.line.includes('\n'), `multi-line entry: ${call.line}`);
  });

  test('the tracer logger stays installed so log entries reach spans', async () => {
    const loggers = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* Logger.CurrentLoggers;
        }).pipe(Effect.provide(RuntimeLogger.layer), withEnv({})),
      ),
    );
    assert.ok(loggers.has(Logger.tracerLogger));
    assert.equal(loggers.size, 2);
  });
});
