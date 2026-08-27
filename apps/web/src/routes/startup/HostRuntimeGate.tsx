import { useEffect, useState } from 'react';

import {
  hasRuntimeHost,
  reconcileRevision,
  subscribeRuntimeStatus,
  type HostRuntimeStatusSnapshot,
} from '../../lib/desktop-bridge.js';

export function useHostRuntimeGate() {
  const hosted = hasRuntimeHost();
  const [snapshot, setSnapshot] = useState<HostRuntimeStatusSnapshot | null>(null);

  useEffect(() => {
    if (!hosted) return;
    return subscribeRuntimeStatus((next) => {
      setSnapshot((current) => reconcileRevision(current, next));
    });
  }, [hosted]);

  // `hosted` is returned rather than re-probed by each consumer: the gate's
  // decision and the workspace's locality must rest on one capability
  // observation, or the two could disagree about what kind of client this is.
  return {
    hosted,
    decision: hosted ? hostRuntimeGateDecision(snapshot) : ('pass' as const),
    snapshot,
  };
}

export function hostRuntimeGateDecision(
  snapshot: HostRuntimeStatusSnapshot | null,
): 'connecting' | 'failed' | 'pass' {
  if (!snapshot || snapshot.state === 'connecting') return 'connecting';
  if (snapshot.ownership === 'managed' && snapshot.state === 'failed') return 'failed';
  return 'pass';
}

export function hostRuntimeAllowsQueries(
  decision: ReturnType<typeof hostRuntimeGateDecision>,
): boolean {
  return decision === 'pass';
}
