import {
  DESKTOP_UPDATE_PROTOCOL_VERSION,
  HOST_RUNTIME_STATUS_PROTOCOL_VERSION,
  type DesktopUpdateSnapshot,
  type HostRuntimeStatusSnapshot,
} from '@isagi/contracts';

export {
  DESKTOP_UPDATE_PROTOCOL_VERSION,
  HOST_RUNTIME_STATUS_PROTOCOL_VERSION,
} from '@isagi/contracts';
export type { DesktopUpdateSnapshot, HostRuntimeStatusSnapshot } from '@isagi/contracts';

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

/**
 * Both host snapshots are monotonically revisioned so that subscribe-then-
 * reconcile is safe: the current-snapshot response may be older than a push that
 * arrived while it was in flight, and the greater revision always wins. One
 * helper, because two copies of this rule is how the two boundaries drift apart.
 */
export function reconcileRevision<T extends { readonly revision: number }>(
  current: T | null,
  next: T,
): T {
  return !current || next.revision > current.revision ? next : current;
}

export function canQuit(): boolean {
  return typeof window !== 'undefined' && typeof window.isagi?.quitApp === 'function';
}

export function requestQuit(): void {
  void window.isagi?.quitApp?.();
}

/**
 * The desktop update capability. A hosted web build has no bridge at all and
 * renders no update chrome; an unpackaged desktop build has the bridge and
 * reports a real `disabled` snapshot with its real version, which is a different
 * fact and a different surface.
 */
export function hasDesktopUpdateHost(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.isagi?.getDesktopUpdate === 'function' &&
    typeof window.isagi.subscribeDesktopUpdate === 'function'
  );
}

export function subscribeDesktopUpdate(
  listener: (snapshot: DesktopUpdateSnapshot) => void,
): () => void {
  return (
    window.isagi?.subscribeDesktopUpdate?.((snapshot) => {
      if (snapshot.protocolVersion === DESKTOP_UPDATE_PROTOCOL_VERSION) listener(snapshot);
    }) ?? (() => {})
  );
}

/**
 * The update intents. Each resolves when the main process has finished the
 * operation, not when the message was accepted — `requestUpdateRestart` in
 * particular settles only once runtime activity has been read.
 */
export const desktopUpdateActions = {
  check: () => invokeHostAction(window.isagi?.checkForUpdates),
  requestRestart: () => invokeHostAction(window.isagi?.requestUpdateRestart),
  confirmRestart: () => invokeHostAction(window.isagi?.confirmUpdateRestart),
  cancelRestart: () => invokeHostAction(window.isagi?.cancelUpdateRestart),
  openDownloadPage: () => invokeHostAction(window.isagi?.openUpdateDownloadPage),
} as const;

/**
 * A rejected intent is not a product state, because no intent reports its
 * outcome this way. Main owns the snapshot and every one of these actions
 * announces what it did there — including `openDownloadPage`, whose launch
 * failure is published as `openFailure` on the manual-install state rather than
 * returned here. So a rejection means the message itself did not survive, which
 * the renderer cannot describe and cannot act on; its only obligation is to stop
 * waiting. If an intent ever gains an outcome the snapshot cannot carry, it
 * needs its own typed result — not a loosening of this rule.
 */
function invokeHostAction(action: (() => Promise<void>) | undefined): Promise<void> {
  if (!action) return Promise.resolve();
  try {
    return action().catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}
