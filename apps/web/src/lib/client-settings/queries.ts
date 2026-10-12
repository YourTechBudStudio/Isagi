import { Duration } from 'effect';

import { keys } from '../state/keys.js';
import { query } from '../state/policy.js';
import { fetchClientSettings } from '../workspace/runtime-data.js';

/**
 * The runtime's client settings. They change only when the runtime restarts, so they are never
 * stale and kept for the whole app session (the old `staleTime`/`gcTime: Infinity`); a failed read
 * is still retried on the next mount.
 */
export const clientSettingsAtom = query(() => fetchClientSettings(), {
  keys: [keys.clientSettings],
  staleTime: Duration.infinity,
  idleTTL: Duration.infinity,
});
