import { useEffect, useState, type ReactNode } from 'react';

import {
  hasRuntimeHost,
  reconcileRuntimeStatus,
  requestQuit,
  requestRelaunch,
  subscribeRuntimeStatus,
  type HostRuntimeStatusSnapshot,
} from '../../lib/desktop-bridge.js';
import { BootSurface } from './StartupSurfaces.js';

export function HostRuntimeGate({ children }: { readonly children: ReactNode }) {
  const hosted = hasRuntimeHost();
  const [snapshot, setSnapshot] = useState<HostRuntimeStatusSnapshot | null>(null);

  useEffect(() => {
    if (!hosted) return;
    return subscribeRuntimeStatus((next) => {
      setSnapshot((current) => reconcileRuntimeStatus(current, next));
    });
  }, [hosted]);

  if (!hosted) return children;
  const decision = hostRuntimeGateDecision(snapshot);
  if (decision === 'connecting') {
    return <BootSurface view={{ kind: 'connecting' }} />;
  }
  if (
    decision === 'managed_failed' &&
    snapshot?.ownership === 'managed' &&
    snapshot.state === 'failed'
  ) {
    return (
      <BootSurface
        view={{
          kind: 'runtime_failed',
          diagnostic: snapshot.diagnostic ?? {},
          onRestart: requestRelaunch,
          onQuit: requestQuit,
        }}
      />
    );
  }

  // External-unreachable is intentionally not a host-owned blocker. Mount the
  // normal gate so its real API request and existing retry path remain authoritative.
  return children;
}

export function hostRuntimeGateDecision(
  snapshot: HostRuntimeStatusSnapshot | null,
): 'connecting' | 'managed_failed' | 'pass' {
  if (!snapshot || snapshot.state === 'connecting') return 'connecting';
  if (snapshot.ownership === 'managed' && snapshot.state === 'failed') return 'managed_failed';
  return 'pass';
}
