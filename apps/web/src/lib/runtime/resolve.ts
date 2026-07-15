import { Effect } from 'effect';

type RuntimeUrlHost = {
  readonly getRuntimeUrl: () => Promise<string>;
};

type RuntimeUrlSources = {
  readonly host: RuntimeUrlHost | undefined;
  readonly viteRuntimeUrl: string | undefined;
};

export function resolveRuntimeUrl(
  sources: RuntimeUrlSources = {
    host: window.isagi,
    viteRuntimeUrl: import.meta.env?.VITE_ISAGI_RUNTIME_URL,
  },
): Effect.Effect<string, Error> {
  // Electron owns runtime lifecycle and its bridge is authoritative. The Vite
  // value exists only for the plain-browser development surface.
  const host = sources.host;
  if (host) {
    return Effect.tryPromise({
      try: () => host.getRuntimeUrl(),
      catch: toError,
    });
  }

  if (sources.viteRuntimeUrl) return Effect.succeed(sources.viteRuntimeUrl);

  return Effect.fail(
    new Error(
      'No runtime URL configured. Set VITE_ISAGI_RUNTIME_URL or open Isagi through Electron.',
    ),
  );
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
