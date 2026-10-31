import { Effect } from 'effect';

import type { ErrorDocument } from '../errors.js';
import { invoke, splitJsonFlag } from '../main.js';

/**
 * Whether the CLI accepts a command line, without targeting a runtime or running anything.
 *
 * The real command tree runs with a runner that does nothing, so everything judged before a
 * request is judged here: commands, flags, value kinds and `requires` pairs. Targeting and `serve`
 * settings depend on the environment and are not. The shipped skill's agreement test checks every
 * documented line with it.
 */
export async function checkCommandLine(
  argv: readonly string[],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: ErrorDocument }> {
  const result = await invoke(splitJsonFlag(argv).rest, {
    client: () => Effect.void,
    serve: () => Effect.void,
  });
  return result.kind === 'done' ? { ok: true } : { ok: false, error: result.failure.document };
}
