import { createContext, useContext } from 'react';

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
 * The default is deliberately `non_local`. A conservative default can only
 * under-offer copy affordances; the opposite default would present a wrong URL
 * as actionable whenever the real value had not been wired up yet.
 *
 * Deriving the production value from the runtime-connection bootstrap is Phase
 * 05's work. Until then every production mount reads this default, and only the
 * browser fixtures provide a `local` value.
 */
export const RuntimeLocalityContext = createContext<RuntimeLocality>('non_local');

export function useRuntimeLocality(): RuntimeLocality {
  return useContext(RuntimeLocalityContext);
}
