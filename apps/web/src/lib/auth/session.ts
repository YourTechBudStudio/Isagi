import { Effect } from 'effect';

import type { apiEndpoints } from '@isagi/contracts';

import { RuntimeApi, type RuntimeCallError } from '../runtime/client.js';

/**
 * Signs this browser in to the runtime, then reloads the page. The runtime sets the session
 * cookie; the reload is the one guarantee that no 401-failed read or held snapshot survives, and
 * boot restores the active context from the runtime (ADR 0001). The request is uninterruptible, so
 * an unmount never aborts a sign-in that reached the runtime.
 */
export const signIn = (input: {
  readonly username: string;
  readonly password: string;
}): Effect.Effect<void, RuntimeCallError<typeof apiEndpoints.auth.login>, RuntimeApi> =>
  RuntimeApi.use((api) => api.signIn(input)).pipe(
    Effect.uninterruptible,
    Effect.andThen(Effect.sync(() => window.location.reload())),
  );
