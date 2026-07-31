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

  return {
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
