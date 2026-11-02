import { fileURLToPath } from 'node:url';

import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from 'effect';
import type { FastifyInstance } from 'fastify';

import type { RuntimeLaunch, SourcedValue } from '@isagi/cli/serve-launch';

import { EditorProvisioningSettings, editorProvisioningDeadline } from '../../editor/index.js';
import { MainLayer, RuntimeServer } from '../http-server.js';
import { launchInputsLayer } from '../launch.js';
import { AppLayer, type RuntimeServices } from '../layer.js';
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
  /** The web workbench build, as `serve --web-root` would pass it. Default none. */
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
}

/** The CLI bundle a source-mode runtime's shim runs, as `scripts/serve-from-source.ts` passes it. */
const cliEntryPath = fileURLToPath(new URL('../../../../cli/dist/isagi.mjs', import.meta.url));

/** The launch `serve` would hand over for `options`: loopback, any free port, unless `config.yaml` says otherwise. */
export function testRuntimeLaunch(options: BootRuntimeOptions): RuntimeLaunch {
  return {
    host: undefined,
    port: undefined,
    dataDirectory: { value: options.dataDirectory, source: 'flag', name: '--data-dir' },
    webRoot: options.webRoot,
    allowedOrigins: options.allowedOrigins ?? [],
    cliEntryPath,
    launcherToken: options.launcherToken,
  };
}

/**
 * Boots the real runtime (`MainLayer`, as `src/index.ts` launches it) in a test-owned scope, from the launch
 * `testRuntimeLaunch(options)` builds, so nothing is read from `process.env` but `ISAGI_RUNTIME_DEBUG`. Editor
 * provisioning is injected with `startAtBoot: false`, so nothing downloads; its state stays `checking`.
 *
 * Effect's default `ConfigProvider` snapshots the environment at the first config read in the process, so each boot
 * gets a provider over the current environment; otherwise every later boot in a test process would see the first
 * one's `ISAGI_RUNTIME_DEBUG`.
 */
export async function bootRuntime(options: BootRuntimeOptions): Promise<BootedRuntime> {
  const scope = Scope.makeUnsafe();
  const services = await Effect.runPromise(
    Layer.buildWithScope(
      // `AppLayer` is merged by reference, so the build makes it once and `run` sees the server's own services.
      Layer.merge(MainLayer, AppLayer).pipe(
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
