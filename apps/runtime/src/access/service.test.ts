import assert from 'node:assert/strict';
import test from 'node:test';

import { Duration, Effect, Exit, Fiber, Layer, Redacted } from 'effect';
import { TestClock } from 'effect/testing';

import { makeLogCapture } from '../../test/test-support.js';
import { InternalEvents } from '../platform/events/index.js';
import { UserShell } from '../platform/process/index.js';
import { RuntimeConfig, type RuntimeAuthSettings } from '../runtime-config/index.js';
import { defaultRuntimeConfig } from '../runtime-config/testing.js';
import { AccessConfigInvalid } from './config.js';
import { readCookie, sessionCookieName } from './cookie.js';
import { sessionMaxAgeSeconds, signSession } from './credentials.js';
import { ProcessTokens } from './process-tokens.js';
import { Access, LauncherToken, loginFailureDelay } from './service.js';

const now = 1_800_000_000;
const credentials = {
  enabled: true,
  username: Redacted.make('ada'),
  password: Redacted.make('env.LOGIN_PASSWORD'),
  signingSecret: Redacted.make('signing-secret'),
} satisfies RuntimeAuthSettings;
const shellEnvironment = { LOGIN_PASSWORD: 'correct horse' };

function accessLayer(
  auth: RuntimeAuthSettings,
  options: { readonly launcherToken?: string; readonly environment?: Record<string, string> } = {},
) {
  return Access.layerNoDeps.pipe(
    Layer.provideMerge(ProcessTokens.layerNoDeps),
    Layer.provideMerge(InternalEvents.layer),
    Layer.provide(
      Layer.succeed(RuntimeConfig, {
        get: Effect.succeed({
          ...defaultRuntimeConfig,
          server: { ...defaultRuntimeConfig.server, auth },
        }),
        acceptHarnessPolicy: () => Effect.die('access tests change no config'),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        UserShell,
        UserShell.of({
          environment: { _tag: 'Available', values: options.environment ?? shellEnvironment },
          run: () => Effect.die('access tests run no shell command'),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(LauncherToken, {
        token:
          options.launcherToken === undefined ? undefined : Redacted.make(options.launcherToken),
      }),
    ),
  );
}

const withAccess = <A, E>(
  layer: ReturnType<typeof accessLayer>,
  effect: Effect.Effect<A, E, Access | ProcessTokens | InternalEvents>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)));

const cookieOf = (setCookie: string) =>
  `${sessionCookieName}=${readCookie(setCookie.split(';')[0], sessionCookieName)}`;
const noHeaders = { authorization: undefined, cookie: undefined };

test('login off: the mode is disabled, nothing is admitted by admit and the session reports none', () =>
  withAccess(
    accessLayer({ enabled: false, password: Redacted.make('env.UNSET') }),
    Effect.gen(function* () {
      const access = yield* Access;
      assert.equal(access.mode, 'disabled');
      assert.equal(
        access.credentialOf({ authorization: 'Bearer x', cookie: undefined }, now),
        'none',
      );
      const exit = yield* Effect.exit(access.login({ username: 'ada', password: 'correct horse' }));
      assert.ok(Exit.isFailure(exit));
    }),
  ));

test('login on with a missing credential fails the build with AccessConfigInvalid and no values', async () => {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* Access;
    }).pipe(
      Effect.provide(
        accessLayer(
          { enabled: true, username: Redacted.make('ada-secret-name') },
          { environment: {} },
        ),
      ),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  const error = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
  assert.ok(
    error !== undefined && error._tag === 'Fail' && error.error instanceof AccessConfigInvalid,
  );
  assert.deepEqual(error.error.problems, [
    { path: 'server.auth.password', problem: 'missing' },
    { path: 'server.auth.signingSecret', problem: 'missing' },
  ]);
  assert.ok(!error.error.message.includes('ada-secret-name'));
});

test('the launcher token and live process tokens admit as token; released, empty and unknown ones do not', () =>
  withAccess(
    accessLayer(credentials, { launcherToken: 'launcher-secret' }),
    Effect.gen(function* () {
      const access = yield* Access;
      const tokens = yield* ProcessTokens;
      const bearer = (token: string) => ({ authorization: `Bearer ${token}`, cookie: undefined });
      assert.deepEqual(access.admit(bearer('launcher-secret'), now), {
        _tag: 'admitted',
        credential: 'token',
        renewCookie: undefined,
      });
      const holder = { _tag: 'pty', ptyProcessId: 9 } as const;
      const processToken = yield* tokens.issue(holder);
      assert.equal(access.admit(bearer(processToken), now)._tag, 'admitted');
      assert.equal(access.credentialOf(bearer(processToken), now), 'token');
      yield* tokens.release(holder);
      assert.deepEqual(access.admit(bearer(processToken), now), { _tag: 'refused' });
      assert.deepEqual(access.admit(bearer('launcher-secre'), now), { _tag: 'refused' });
      assert.deepEqual(access.admit({ authorization: 'Bearer ', cookie: undefined }, now), {
        _tag: 'refused',
      });
      assert.deepEqual(access.admit(noHeaders, now), { _tag: 'refused' });
      assert.equal(access.credentialOf(noHeaders, now), 'none');
    }),
  ));

test('without a launcher token an empty bearer never admits', () =>
  withAccess(
    accessLayer(credentials),
    Effect.gen(function* () {
      const access = yield* Access;
      for (const authorization of ['Bearer ', 'Bearer', 'Bearer  ', 'bearer \t']) {
        assert.deepEqual(access.admit({ authorization, cookie: undefined }, now), {
          _tag: 'refused',
        });
      }
    }),
  ));

test('a valid cookie admits as cookie, renews only after a day, and survives an invalid bearer', () =>
  withAccess(
    accessLayer(credentials),
    Effect.gen(function* () {
      const access = yield* Access;
      const cookie = `other=1; ${sessionCookieName}=${signSession(credentials.signingSecret, now)}`;
      assert.deepEqual(access.admit({ authorization: undefined, cookie }, now + 60), {
        _tag: 'admitted',
        credential: 'cookie',
        renewCookie: undefined,
      });
      assert.equal(access.credentialOf({ authorization: 'Bearer wrong', cookie }, now), 'cookie');
      const later = now + 24 * 60 * 60 + 1;
      const renewed = access.admit({ authorization: undefined, cookie }, later);
      assert.ok(renewed._tag === 'admitted' && renewed.renewCookie !== undefined);
      assert.equal(
        renewed.renewCookie,
        `${sessionCookieName}=${signSession(credentials.signingSecret, later)}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`,
      );
      assert.deepEqual(
        access.admit({ authorization: undefined, cookie }, now + sessionMaxAgeSeconds),
        {
          _tag: 'refused',
        },
      );
    }),
  ));

test('a cookie survives a fresh Access with the same secret and a changed password, but not a new secret', async () => {
  const cookie = `${sessionCookieName}=${signSession(credentials.signingSecret, now)}`;
  const admitted = (auth: RuntimeAuthSettings) =>
    withAccess(
      accessLayer(auth),
      Access.use((access) =>
        Effect.succeed(access.admit({ authorization: undefined, cookie }, now)._tag),
      ),
    );
  assert.equal(await admitted(credentials), 'admitted');
  assert.equal(
    await admitted({ ...credentials, password: Redacted.make('a new password') }),
    'admitted',
  );
  assert.equal(
    await admitted({ ...credentials, signingSecret: Redacted.make('rotated') }),
    'refused',
  );
});

test('a login with the right pair returns a cookie the guard admits, and logs no credential', async () => {
  const logs = makeLogCapture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const access = yield* Access;
      const setCookie = yield* access.login({ username: 'ada', password: 'correct horse' });
      assert.match(
        setCookie,
        /^isagi_session=v1\.\d+\.[\w-]+; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/,
      );
      const nowSeconds = Math.floor(Date.now() / 1000);
      assert.equal(
        access.admit({ authorization: undefined, cookie: cookieOf(setCookie) }, nowSeconds)._tag,
        'admitted',
      );
    }).pipe(Effect.provide(accessLayer(credentials)), Effect.provide(logs.layer)),
  );
  assert.deepEqual(
    logs.lines.map((line) => [line.level, line.message]),
    [
      ['Info', 'Runtime login is on'],
      ['Info', 'Runtime login succeeded'],
    ],
  );
  const text = JSON.stringify(logs.lines);
  for (const secret of ['ada', 'correct horse', 'signing-secret', 'isagi_session']) {
    assert.ok(!text.includes(secret), secret);
  }
});

test('failed logins wait min(250 ms × 2^(n−1), 5 s), count before waiting, and reset on success', async () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 40].map((n) => Duration.toMillis(loginFailureDelay(n))),
    [250, 500, 1000, 2000, 4000, 5000, 5000, 5000],
  );
  const logs = makeLogCapture();
  await withAccess(
    accessLayer(credentials),
    Effect.gen(function* () {
      const access = yield* Access;
      const wrong = { username: 'ada', password: 'wrong' };
      // A failure is not answered before its delay.
      const first = yield* Effect.forkChild(Effect.exit(access.login(wrong)));
      yield* TestClock.adjust('249 millis');
      assert.equal(first.pollUnsafe(), undefined);
      yield* TestClock.adjust('1 millis');
      const firstExit = yield* Fiber.join(first);
      assert.ok(Exit.isFailure(firstExit));
      // An interrupted attempt (a client that disconnects mid-wait) still counts.
      const second = yield* Effect.forkChild(access.login(wrong));
      yield* TestClock.adjust('10 millis');
      yield* Fiber.interrupt(second);
      const third = yield* Effect.forkChild(Effect.exit(access.login(wrong)));
      yield* TestClock.adjust('999 millis');
      assert.equal(third.pollUnsafe(), undefined);
      yield* TestClock.adjust('1 millis');
      assert.ok(Exit.isFailure(yield* Fiber.join(third)));
      // Success resets the count: the next failure waits 250 ms again.
      yield* access.login({ username: 'ada', password: 'correct horse' });
      const fourth = yield* Effect.forkChild(Effect.exit(access.login(wrong)));
      yield* TestClock.adjust('250 millis');
      assert.ok(Exit.isFailure(yield* Fiber.join(fourth)));
    }).pipe(Effect.provide(logs.layer), Effect.provide(TestClock.layer())),
  );
  const failures = logs.lines.filter((line) => line.message === 'Runtime login failed');
  assert.deepEqual(
    failures.map((line) => [line.level, line.annotations.consecutiveFailures]),
    [
      ['Warn', 1],
      ['Warn', 2],
      ['Warn', 3],
      ['Warn', 1],
    ],
  );
  const text = JSON.stringify(logs.lines);
  assert.ok(!text.includes('wrong') && !text.includes('correct horse'));
});
