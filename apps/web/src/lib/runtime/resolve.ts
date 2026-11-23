import { Data, Effect } from 'effect';

/** Everything runtime discovery reads, so node tests pass it in and never touch `window`. */
export type RuntimeUrlSources = {
  /** `location.origin` when the page is http(s); undefined for anything else. */
  readonly pageOrigin: string | undefined;
};

/**
 * No runtime URL to call: the page is not served over http(s). Not a runtime-client failure, so the UI classifies it
 * as unknown.
 */
export class RuntimeUrlUnavailable extends Data.TaggedError('RuntimeUrlUnavailable')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The runtime this page talks to: always the page's own origin. Every runtime serves the web UI, and the desktop
 * loads it from its runtime exactly as a browser does, so the page's origin is the runtime's address. In Vite
 * development the dev server proxies `/api` and `/editor` to the runtime, so the Vite origin works the same way.
 *
 * Without `sources` it reads the page.
 */
export function resolveRuntimeUrl(
  sources?: RuntimeUrlSources,
): Effect.Effect<string, RuntimeUrlUnavailable> {
  const { pageOrigin } = sources ?? { pageOrigin: readPageOrigin() };
  if (pageOrigin) return Effect.succeed(pageOrigin);
  return Effect.fail(
    new RuntimeUrlUnavailable({
      message: "No runtime URL: open Isagi from the runtime's own address.",
    }),
  );
}

function readPageOrigin(): string | undefined {
  const location = globalThis.window?.location;
  return location && /^https?:$/.test(location.protocol) ? location.origin : undefined;
}
