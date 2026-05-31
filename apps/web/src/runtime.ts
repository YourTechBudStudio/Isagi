import { Effect } from 'effect';

export function resolveRuntimeUrl() {
  const viteRuntimeUrl = import.meta.env.VITE_ISAGI_RUNTIME_URL;

  if (viteRuntimeUrl) {
    return Effect.succeed(viteRuntimeUrl);
  }

  if (window.isagi) {
    return Effect.tryPromise({
      try: () => window.isagi!.getRuntimeUrl(),
      catch: toError,
    });
  }

  return Effect.fail(
    new Error(
      'No runtime URL configured. Set VITE_ISAGI_RUNTIME_URL or open Isagi through Electron.',
    ),
  );
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
