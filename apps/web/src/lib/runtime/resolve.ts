import { Data, Effect } from 'effect';

type RuntimeUrlHost = {
  readonly getRuntimeUrl: () => Promise<string>;
};

type RuntimeUrlSources = {
  readonly host: RuntimeUrlHost | undefined;
  readonly viteRuntimeUrl: string | undefined;
};

/**
 * No runtime URL to call: the desktop bridge failed to report one, or the plain-browser surface has
 * no `VITE_ISAGI_RUNTIME_URL`. Not a runtime-client failure, so the UI classifies it as unknown.
 */
export class RuntimeUrlUnavailable extends Data.TaggedError('RuntimeUrlUnavailable')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function resolveRuntimeUrl(
  sources: RuntimeUrlSources = {
    host: window.isagi,
    viteRuntimeUrl: import.meta.env?.VITE_ISAGI_RUNTIME_URL,
  },
): Effect.Effect<string, RuntimeUrlUnavailable> {
  // Electron owns runtime lifecycle and its bridge is authoritative. The Vite
  // value exists only for the plain-browser development surface.
  const host = sources.host;
  if (host) {
    return Effect.tryPromise({
      try: () => host.getRuntimeUrl(),
      catch: (cause) =>
        new RuntimeUrlUnavailable({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  }

  if (sources.viteRuntimeUrl) return Effect.succeed(sources.viteRuntimeUrl);

  return Effect.fail(
    new RuntimeUrlUnavailable({
      message:
        'No runtime URL configured. Set VITE_ISAGI_RUNTIME_URL or open Isagi through Electron.',
    }),
  );
}
