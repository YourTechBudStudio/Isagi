import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from 'effect';
import type { FastifyInstance } from 'fastify';

import { MainLayer, RuntimeServer } from '../http-server.js';
import { RuntimeLogger } from '../logger.js';

export interface BootedRuntime {
  /** The listening server; drive it with `inject`/`injectWS` or over `url`. */
  readonly server: FastifyInstance;
  readonly url: string;
  /** Shuts the runtime down the way a signal does: closes the scope `MainLayer` was built in. Idempotent. */
  readonly close: () => Promise<void>;
}

export interface BootRuntimeOptions {
  /**
   * Provided around the whole runtime instead of `RuntimeLogger.layer`, so it reaches construction, request fibers and
   * background fibers: a log capture, a fiber probe, or `RuntimeLogger.layer` merged with either.
   */
  readonly extraLayer?: Layer.Layer<never, unknown> | undefined;
}

/**
 * Boots the real runtime (`MainLayer`, as `src/index.ts` launches it) in a test-owned scope, against the process
 * environment as it is now (`ISAGI_DATA_DIR`, `HOST`, `PORT`, …). The caller sets the environment first and restores it
 * after `close`.
 *
 * Effect's default `ConfigProvider` snapshots the environment at the first config read in the process, so each boot
 * gets a provider over the current environment; otherwise every later boot in a test process would see the first
 * one's settings.
 */
export async function bootRuntime(options: BootRuntimeOptions = {}): Promise<BootedRuntime> {
  const scope = Scope.makeUnsafe();
  const services = await Effect.runPromise(
    Layer.buildWithScope(MainLayer, scope).pipe(
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
  };
}
