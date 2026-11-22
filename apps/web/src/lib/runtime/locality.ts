import { createContext, useContext } from 'react';

/**
 * Whether the runtime serving this client runs on the same machine as the client.
 *
 * It decides one thing: whether a composed `http://localhost:<port>` URL is
 * actionable. For a co-located runtime it is. For any other connection — a
 * tunnelled runtime, a runtime opened from another machine's browser — that URL
 * names the machine the *client* runs on, not the one running the command, so
 * offering it to copy would hand the user a known-wrong address.
 *
 * URL shape is never used to infer this. A loopback origin can be an SSH tunnel
 * to a remote runtime, and a same-machine runtime can be addressed by hostname;
 * both directions of that guess are wrong in a way the user cannot see.
 */
export type RuntimeLocality = 'local' | 'non_local';

/**
 * The one authoritative derivation, kept pure and total so it can be tested over
 * its whole input space without a host bridge or a Vite environment.
 *
 * - **hosted** → `local`. The desktop only ever loads the UI of the runtime it
 *   spawned on the client's own host, so co-location holds by construction.
 * - **unhosted** → `local` only for the exact literal `'true'` of the build-time
 *   browser assertion. Any other value — absent, empty, `'TRUE'`, `'1'`,
 *   malformed — is `non_local`, because a wrong assertion recreates precisely the
 *   wrong-localhost-URL hazard this type exists to prevent.
 */
export function deriveRuntimeLocality(input: {
  readonly hosted: boolean;
  readonly browserLocalAssertion: string | undefined;
}): RuntimeLocality {
  if (input.hosted) return 'local';
  return input.browserLocalAssertion === 'true' ? 'local' : 'non_local';
}

/**
 * The default is deliberately `non_local`. A conservative default can only
 * under-offer copy affordances; the opposite default would present a wrong URL
 * as actionable whenever the real value had not been wired up yet.
 *
 * `StartupGate` provides the derived production value around `WorkspacePage`.
 * The default therefore covers only an out-of-model mount outside that provider.
 */
export const RuntimeLocalityContext = createContext<RuntimeLocality>('non_local');

export function useRuntimeLocality(): RuntimeLocality {
  return useContext(RuntimeLocalityContext);
}
