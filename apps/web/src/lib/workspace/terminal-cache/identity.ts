import type { DurablePtySessionKind } from '@isagi/contracts';

export interface TerminalSessionIdentity {
  /**
   * The narrow durable-session vocabulary, not the wider pane-content kind. This
   * cache keys live PTY attachments, so it can only ever describe a session that
   * owns a process the client attaches to.
   */
  readonly kind: DurablePtySessionKind;
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
