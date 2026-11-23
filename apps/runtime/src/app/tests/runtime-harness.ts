import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from 'effect';
import type { FastifyInstance } from 'fastify';

import type { RuntimeLaunch, SourcedValue } from '@isagi/cli/serve-launch';

import { EditorProvisioningSettings, editorProvisioningDeadline } from '../../editor/index.js';
import type { UserShell } from '../../platform/process/index.js';
import { userShellBaseEnv } from '../../platform/process/index.js';
import { commandNotFound, testUserShellLayer } from '../../platform/process/testing.js';
import { HttpServerLayer, RuntimeServer } from '../http-server.js';
import { launchInputsLayer } from '../launch.js';
import { appLayer, platformLayer, type RuntimeServices } from '../layer.js';
import { RuntimeLogger } from '../logger.js';

export interface BootedRuntime {
  /** The listening server; drive it with `inject`/`injectWS` or over `url`. */
  readonly server: FastifyInstance;
  readonly url: string;
  /** Shuts the runtime down the way a signal does: closes the scope `MainLayer` was built in. Idempotent. */
  readonly close: () => Promise<void>;
  /** Runs `effect` against the services this runtime's routes use: the same instances, not a second build. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, RuntimeServices>) => Promise<A>;
}

export interface BootRuntimeOptions {
  /** The data root, as `serve --data-dir` would pass it. */
  readonly dataDirectory: string;
  /** The browser origins the server accepts, as `serve --allowed-origins` would pass them. Default none. */
  readonly allowedOrigins?: readonly string[];
  /**
   * The web workbench build, as `serve --web-root` would pass it. Omitted: {@link testWebRoot}, a minimal document.
   * An explicit `undefined` is a runtime started without one (a startup error).
   */
  readonly webRoot?: SourcedValue<string> | undefined;
  /**
   * Provided around the whole runtime instead of `RuntimeLogger.layer`, so it reaches construction, request fibers and
   * background fibers: a log capture, a fiber probe, or `RuntimeLogger.layer` merged with either.
   */
  readonly extraLayer?: Layer.Layer<never, unknown> | undefined;
  /**
   * The desktop's launcher token, as `serve` would read it from `ISAGI_LAUNCHER_TOKEN`. Default none. Login itself is
   * turned on the way a user does it: `server.auth` in the data root's `config.yaml`.
   */
  readonly launcherToken?: string | undefined;
  /** The user's shell. Default {@link testRuntimeUserShell}: never spawns the developer's login shell. */
  readonly userShell?: Layer.Layer<UserShell> | undefined;
}

/**
 * The shell a booted test runtime sees: the test process's own environment as the probed login-shell environment, so
 * terminals still find `sh`, `git` and the rest, and no harness CLI installed, so the startup inventory settles at
 * once and nothing depends on what the developer has installed or on their rc files.
 */
export const testRuntimeUserShell = () =>
  testUserShellLayer({ environment: userShellBaseEnv(process.env), run: commandNotFound });

/** The runtime's service graph, as `AppLayer` builds it, over `userShell` (default {@link testRuntimeUserShell}). */
export function testAppLayer(userShell: Layer.Layer<UserShell> = testRuntimeUserShell()) {
  return appLayer(platformLayer(userShell));
}

/** The CLI bundle a source-mode runtime's shim runs, as `scripts/serve-from-source.ts` passes it. */
const cliEntryPath = fileURLToPath(new URL('../../../../cli/dist/isagi.mjs', import.meta.url));

/** A minimal built-workbench stand-in: one `index.html`. Every runtime serves a web root, so every test boot has one. */
export const testWebRoot: SourcedValue<string> = {
  value: fileURLToPath(new URL('../../../test/fixtures/web-root', import.meta.url)),
  source: 'flag',
  name: '--web-root',
};

/** The launch `serve` would hand over for `options`: loopback, any free port, unless `config.yaml` says otherwise. */
export function testRuntimeLaunch(options: BootRuntimeOptions): RuntimeLaunch {
  return {
    host: undefined,
    port: undefined,
    dataDirectory: { value: options.dataDirectory, source: 'flag', name: '--data-dir' },
    webRoot: 'webRoot' in options ? options.webRoot : testWebRoot,
    allowedOrigins: options.allowedOrigins ?? [],
    cliEntryPath,
    launcherToken: options.launcherToken,
  };
}

/**
 * Boots the real runtime (`MainLayer`'s server over the app graph, as `src/index.ts` launches it) in a test-owned
 * scope, from the launch `testRuntimeLaunch(options)` builds, so nothing is read from `process.env` but
 * `ISAGI_RUNTIME_DEBUG` and the environment {@link testRuntimeUserShell} hands terminals. Editor provisioning is
 * injected with `startAtBoot: false`, so nothing downloads; its state stays `checking`.
 *
 * Effect's default `ConfigProvider` snapshots the environment at the first config read in the process, so each boot
 * gets a provider over the current environment; otherwise every later boot in a test process would see the first
 * one's `ISAGI_RUNTIME_DEBUG`.
 */
export async function bootRuntime(options: BootRuntimeOptions): Promise<BootedRuntime> {
  const scope = Scope.makeUnsafe();
  const app = testAppLayer(options.userShell);
  const services = await Effect.runPromise(
    Layer.buildWithScope(
      // `app` is merged by reference, so the build makes it once and `run` sees the server's own services.
      Layer.merge(HttpServerLayer.pipe(Layer.provide(app)), app).pipe(
        Layer.provide(launchInputsLayer(testRuntimeLaunch(options))),
        Layer.provide(
          Layer.succeed(EditorProvisioningSettings, {
            deadline: editorProvisioningDeadline,
            startAtBoot: false,
          }),
        ),
      ),
      scope,
    ).pipe(
      Effect.provide(options.extraLayer ?? RuntimeLogger.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    ),
  );
  const { fastify, url } = Context.get(services, RuntimeServer);
  let closing: Promise<void> | undefined;
  return {
    server: fastify,
    url,
    close: () => {
      closing ??= Effect.runPromise(Scope.close(scope, Exit.void));
      return closing;
    },
    run: (effect) => Effect.runPromise(Effect.provideContext(effect, services)),
  };
}
