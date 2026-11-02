import { randomBytes } from 'node:crypto';

import { Clock, Context, Data, Duration, Effect, Layer, Redacted, Ref, Result } from 'effect';

import { launchEnv, UserShell } from '../platform/process/index.js';
import { RuntimeConfig } from '../runtime-config/index.js';
import { resolveAuthMode, type AccessConfigInvalid, type AuthMode } from './config.js';
import { readCookie, sessionCookieName, sessionSetCookie } from './cookie.js';
import { bearerToken, sameSecret, signSession, verifySession } from './credentials.js';
import { ProcessTokens } from './process-tokens.js';

/**
 * The desktop's private bearer token, from `ISAGI_LAUNCHER_TOKEN` (which `serve` removes from the environment before
 * the runtime loads). `access/`'s own launch input; `app/launch.ts` provides it.
 */
export class LauncherToken extends Context.Service<
  LauncherToken,
  { readonly token: Redacted.Redacted<string> | undefined }
>()('isagi/runtime/access/LauncherToken') {}

/** How a request was admitted; `none` only when login is off. */
export type Credential = 'none' | 'token' | 'cookie';

export interface RequestCredentials {
  readonly authorization: string | undefined;
  readonly cookie: string | undefined;
}

export type Admission =
  | {
      readonly _tag: 'admitted';
      readonly credential: Exclude<Credential, 'none'>;
      /** A fresh `Set-Cookie` once the cookie is older than a day. */
      readonly renewCookie: string | undefined;
    }
  | { readonly _tag: 'refused' };

/** The username or password did not match; which one is never said. */
export class AccessLoginFailed extends Data.TaggedError('AccessLoginFailed')<{}> {}

const maxLoginDelay = Duration.seconds(5);

/** `min(250 ms × 2^(n−1), 5 s)` after the n-th consecutive failure. */
export const loginFailureDelay = (failures: number) =>
  Duration.min(Duration.millis(250 * 2 ** Math.min(failures - 1, 16)), maxLoginDelay);

const make = Effect.gen(function* () {
  const config = yield* RuntimeConfig.use((runtimeConfig) => runtimeConfig.get);
  const userShell = yield* UserShell;
  const launcher = yield* LauncherToken;
  const processTokens = yield* ProcessTokens;
  // The sanitized login-shell environment Fluidcast keys resolve against, so `env.NAME` means one thing in config.yaml.
  const resolved = resolveAuthMode(config.server.auth, launchEnv(userShell.environment.values));
  if (Result.isFailure(resolved)) return yield* Effect.fail(resolved.failure);
  const mode: AuthMode = resolved.success;
  const comparisonKey = randomBytes(32);
  const failures = yield* Ref.make(0);
  const launcherToken = launcher.token === undefined ? '' : Redacted.value(launcher.token);
  yield* Effect.logInfo(mode._tag === 'enabled' ? 'Runtime login is on' : 'Runtime login is off');

  const admit = (headers: RequestCredentials, nowSeconds: number): Admission => {
    if (mode._tag === 'disabled') return { _tag: 'refused' };
    const token = bearerToken(headers.authorization);
    if (
      token !== undefined &&
      ((launcherToken !== '' && sameSecret(comparisonKey, token, launcherToken)) ||
        processTokens.isLive(token))
    ) {
      return { _tag: 'admitted', credential: 'token', renewCookie: undefined };
    }
    // An invalid bearer is not an error in itself: the cookie is still checked.
    const cookie = readCookie(headers.cookie, sessionCookieName);
    if (cookie !== undefined) {
      const check = verifySession(mode.signingSecret, cookie, nowSeconds);
      if (check._tag === 'valid') {
        return {
          _tag: 'admitted',
          credential: 'cookie',
          renewCookie: check.renew
            ? sessionSetCookie(signSession(mode.signingSecret, nowSeconds))
            : undefined,
        };
      }
    }
    return { _tag: 'refused' };
  };

  return Access.of({
    mode: mode._tag,
    admit,
    credentialOf: (headers, nowSeconds) => {
      if (mode._tag === 'disabled') return 'none';
      const admission = admit(headers, nowSeconds);
      return admission._tag === 'admitted' ? admission.credential : 'none';
    },
    login: Effect.fn('Access.login')(function* (input: {
      readonly username: string;
      readonly password: string;
    }) {
      if (mode._tag === 'disabled') return yield* new AccessLoginFailed();
      // Both are always compared before combining, so the timing does not say which one failed.
      const usernameMatches = sameSecret(
        comparisonKey,
        input.username,
        Redacted.value(mode.username),
      );
      const passwordMatches = sameSecret(
        comparisonKey,
        input.password,
        Redacted.value(mode.password),
      );
      if (usernameMatches && passwordMatches) {
        yield* Ref.set(failures, 0);
        yield* Effect.logInfo('Runtime login succeeded');
        const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        return sessionSetCookie(signSession(mode.signingSecret, nowSeconds));
      }
      // Counted before the wait, so an attempt whose client disconnects mid-wait still counts.
      const count = yield* Ref.updateAndGet(failures, (n) => n + 1);
      yield* Effect.logWarning('Runtime login failed').pipe(
        Effect.annotateLogs({ consecutiveFailures: count }),
      );
      yield* Effect.sleep(loginFailureDelay(count));
      return yield* new AccessLoginFailed();
    }),
  });
});

/**
 * Runtime login (`server.auth`): the resolved mode, the admission check the guard runs on every request, and the
 * login the auth routes call. Building it fails with `AccessConfigInvalid` when login is on but a credential is
 * missing or unreadable, which fails startup before `listen` (AC6).
 */
export class Access extends Context.Service<
  Access,
  {
    readonly mode: AuthMode['_tag'];
    /** Bearer first (launcher or live process token), then the cookie. Pure over memory; refuses when login is off. */
    readonly admit: (headers: RequestCredentials, nowSeconds: number) => Admission;
    /** What `auth.session` reports for a request: `none` when login is off or nothing valid was sent. */
    readonly credentialOf: (headers: RequestCredentials, nowSeconds: number) => Credential;
    /** Checks a login, holding a failure for the throttle delay; succeeds with a fresh `Set-Cookie` value. */
    readonly login: (input: {
      readonly username: string;
      readonly password: string;
    }) => Effect.Effect<string, AccessLoginFailed>;
  }
>()('isagi/runtime/access/Access') {
  static readonly layerNoDeps: Layer.Layer<
    Access,
    AccessConfigInvalid,
    RuntimeConfig | UserShell | LauncherToken | ProcessTokens
  > = Layer.effect(Access, make);
  /** Provides `ProcessTokens.layer` by reference, so it shares the one instance `CliAccess.layer` will provide. */
  static readonly layer = Access.layerNoDeps.pipe(Layer.provide(ProcessTokens.layer));
}
