import { Effect } from 'effect';

import { appRuntime } from '../state/runtime.js';
import { RuntimeApi } from './client.js';

/**
 * The runtime URL that embedded content is addressed against. Two users read it:
 *
 * - the Fluidcast player builds its connection from it, resolved before the player renders so the
 *   connection layer itself cannot fail; a failure shows the pane's runtime-unreachable fallback
 *   instead of a player;
 * - the editor pane resolves the runtime-relative `/editor/<id>/` path the projection supplies
 *   against it, and waits while it is unresolved.
 */
export const runtimeUrlAtom = appRuntime.atom(
  Effect.gen(function* () {
    const api = yield* RuntimeApi;
    return yield* api.resolveRuntimeUrl();
  }),
);
