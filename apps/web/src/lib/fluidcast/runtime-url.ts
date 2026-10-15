import { Effect } from 'effect';

import { RuntimeApi } from '../runtime/client.js';
import { appRuntime } from '../state/runtime.js';

/**
 * The runtime URL an embedded player builds its connection from. Resolved before the player
 * renders, so the connection layer itself cannot fail; a failure shows the pane's
 * runtime-unreachable fallback instead of a player.
 */
export const runtimeUrlAtom = appRuntime.atom(
  Effect.gen(function* () {
    const api = yield* RuntimeApi;
    return yield* api.resolveRuntimeUrl();
  }),
);
