import type { PaneSessionKind } from '@isagi/contracts';

export interface TerminalSessionIdentity {
  readonly kind: PaneSessionKind;
  readonly sessionId: number;
}

export interface TerminalPlacement {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId: number;
}

export function terminalSessionKey(identity: TerminalSessionIdentity): string {
  return `${identity.kind}:${identity.sessionId}`;
}

export function terminalPlacementKey(placement: TerminalPlacement): string {
  return `${placement.worktreeId}:${placement.surfaceId}:${placement.paneId}`;
}

export function terminalPlacementsEqual(
  left: TerminalPlacement,
  right: TerminalPlacement,
): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    left.surfaceId === right.surfaceId &&
    left.paneId === right.paneId
  );
}
