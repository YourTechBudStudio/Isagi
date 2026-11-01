import { Data, Effect } from 'effect';

type RuntimeUrlHost = {
  readonly getRuntimeUrl: () => Promise<string>;
};

/** Everything runtime discovery reads, so node tests pass it in and never touch `window` or `import.meta.env`. */
export type RuntimeUrlSources = {
  /** The desktop bridge, when the page runs inside the desktop app. */
  readonly host: RuntimeUrlHost | undefined;
  /** `VITE_ISAGI_RUNTIME_URL`, read only in Vite development; always undefined in a production build. */
  readonly developmentRuntimeUrl: string | undefined;
  /** `location.origin` when the page is http(s); undefined for `file:`. */
  readonly pageOrigin: string | undefined;
};

/**
 * No runtime URL to call: the desktop bridge failed to report one, or the page is neither served over http(s) nor
 * given a development URL. Not a runtime-client failure, so the UI classifies it as unknown.
 */
export class RuntimeUrlUnavailable extends Data.TaggedError('RuntimeUrlUnavailable')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The runtime this page talks to. The desktop bridge is authoritative; then, in Vite development only,
 * `VITE_ISAGI_RUNTIME_URL`; then the page's own origin, because a page the runtime served is at the runtime's
 * address. A Vite dev page without the variable therefore targets the Vite origin and fails as unreachable.
 *
 * Without `sources` it reads the page, and the fallbacks only when there is no bridge.
 */
export function resolveRuntimeUrl(
  sources?: RuntimeUrlSources,
): Effect.Effect<string, RuntimeUrlUnavailable> {
  const host = sources === undefined ? window.isagi : sources.host;
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

  const { developmentRuntimeUrl, pageOrigin } = sources ?? browserFallbacks();
  if (developmentRuntimeUrl) return Effect.succeed(developmentRuntimeUrl);
  if (pageOrigin) return Effect.succeed(pageOrigin);

  return Effect.fail(
    new RuntimeUrlUnavailable({
      message:
        "No runtime URL: open Isagi through the desktop app or from the runtime's own address (or set VITE_ISAGI_RUNTIME_URL in Vite development).",
    }),
  );
}

function browserFallbacks(): Omit<RuntimeUrlSources, 'host'> {
  return {
    developmentRuntimeUrl: readDevelopmentRuntimeUrl(),
    pageOrigin: /^https?:$/.test(window.location.protocol) ? window.location.origin : undefined,
  };
}

function readDevelopmentRuntimeUrl(): string | undefined {
  try {
    // Exact member reads inside a `DEV` guard: Vite replaces each one, so a production build drops the branch and
    // never carries the value. Any other shape (`import.meta.env?.X`, a bare `import.meta.env`) would ship it.
    return import.meta.env.DEV ? import.meta.env.VITE_ISAGI_RUNTIME_URL : undefined;
  } catch {
    // Outside Vite (node tests) `import.meta.env` is undefined: there is no development URL.
    return undefined;
  }
}
