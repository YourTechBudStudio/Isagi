import {
  HOST_RUNTIME_STATUS_PROTOCOL_VERSION,
  type HostRuntimeStatusSnapshot,
} from '@isagi/contracts';

export { HOST_RUNTIME_STATUS_PROTOCOL_VERSION } from '@isagi/contracts';
export type { HostRuntimeStatusSnapshot } from '@isagi/contracts';

export function hasRuntimeHost(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.isagi?.getRuntimeStatus === 'function' &&
    typeof window.isagi.subscribeRuntimeStatus === 'function'
  );
}

export function subscribeRuntimeStatus(
  listener: (snapshot: HostRuntimeStatusSnapshot) => void,
): () => void {
  return (
    window.isagi?.subscribeRuntimeStatus?.((snapshot) => {
      if (snapshot.protocolVersion === HOST_RUNTIME_STATUS_PROTOCOL_VERSION) listener(snapshot);
    }) ?? (() => {})
  );
}

export function reconcileRuntimeStatus(
  current: HostRuntimeStatusSnapshot | null,
  next: HostRuntimeStatusSnapshot,
) {
  return !current || next.revision > current.revision ? next : current;
}

export function canQuit(): boolean {
  return typeof window !== 'undefined' && typeof window.isagi?.quitApp === 'function';
}

export function requestQuit(): void {
  void window.isagi?.quitApp?.();
}
