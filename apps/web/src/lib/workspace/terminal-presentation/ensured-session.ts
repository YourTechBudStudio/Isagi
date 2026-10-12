import { useLayoutEffect, useState } from 'react';

import type {
  TerminalPlacement,
  TerminalPresentationCache,
  TerminalPresentationResource,
  TerminalSessionEnsureResult,
  TerminalSessionIdentity,
} from '../terminal-cache/index.js';

/**
 * The cache's handle for a pane's session, ensured after commit rather than during render.
 *
 * Ensuring creates the session's cache entry the first time it is seen, and the cache publishes that
 * to every pane subscribed to it. That is a store write: made during render it re-rendered the
 * neighbouring pane in the middle of this one's ("Cannot update a component while rendering a
 * different component"), so it runs in a layout effect, still before paint. The handle is keyed by
 * cache and identity, so the render after an identity change never pairs the new identity with the
 * previous session's handle.
 */
export function useEnsuredTerminalSession<Resource extends TerminalPresentationResource>(
  cache: TerminalPresentationCache<Resource>,
  identity: TerminalSessionIdentity | null,
  placement: TerminalPlacement,
): TerminalSessionEnsureResult<Resource> | null {
  const identityKey = identity ? `${identity.kind}:${identity.sessionId}` : null;
  const [ensured, setEnsured] = useState<{
    readonly cache: TerminalPresentationCache<Resource>;
    readonly identityKey: string;
    readonly handle: TerminalSessionEnsureResult<Resource>;
  } | null>(null);
  useLayoutEffect(() => {
    if (!identity || identityKey === null) return;
    const result = cache.ensureSession(identity, placement);
    setEnsured(result.status === 'ensured' ? { cache, identityKey, handle: result } : null);
  }, [cache, identityKey]);
  return ensured?.cache === cache && ensured.identityKey === identityKey ? ensured.handle : null;
}
