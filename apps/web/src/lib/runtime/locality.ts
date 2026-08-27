import { createContext, useContext } from 'react';

import type { HostRuntimeStatusSnapshot } from '../desktop-bridge.js';

/**
 * Whether the runtime serving this client runs on the same machine as the client.
 *
 * It decides one thing: whether a composed `http://localhost:<port>` URL is
 * actionable. For a co-located runtime it is. For any other connection — the
 * desktop attached to an external `ISAGI_RUNTIME_URL`, a tunnelled runtime, a
 * plain browser build — that URL names the machine the *client* runs on, not the
 * one running the command, so offering it to copy would hand the user a
 * known-wrong address.
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
 * The precedence is the point: when the desktop bridge is present its ownership
 * fact always wins, and the build-time browser assertion is consulted only for a
 * plain-browser client that has no bridge to ask.
 *
 * - **hosted + `managed`** → `local`. The desktop spawned this runtime on the
 *   client's own host, so co-location holds by construction.
 * - **hosted + `external`** → `non_local`. This does not assert the runtime *is*
 *   remote; it asserts that locality was never established. Withholding a URL is
 *   the correct answer to "unknown".
 * - **hosted + no snapshot** → `non_local`. `StartupGate` does not mount workspace
 *   surfaces in this state, but the function stays total so a future caller
 *   cannot fall into a gap.
 * - **unhosted** → `local` only for the exact literal `'true'`. Any other value —
 *   absent, empty, `'TRUE'`, `'1'`, malformed — is `non_local`, because a wrong
 *   assertion recreates precisely the wrong-localhost-URL hazard this type exists
 *   to prevent.
 */
export function deriveRuntimeLocality(input: {
  readonly hosted: boolean;
  readonly snapshot: HostRuntimeStatusSnapshot | null;
  readonly browserLocalAssertion: string | undefined;
}): RuntimeLocality {
  if (input.hosted) {
    return input.snapshot?.ownership === 'managed' ? 'local' : 'non_local';
  }
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
