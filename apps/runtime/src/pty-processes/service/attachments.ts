import { Effect } from 'effect';

import { PtyServiceError, type BackendAttachment } from '../types.js';

export interface ActiveAttachment {
  readonly ptyProcessId: number;
  readonly attachmentId: symbol;
  readonly attachment: BackendAttachment;
  /**
   * Closes the attachment's own scope: the backend detaches (node-pty stops routing output to it, tmux kills its
   * attach client) and its output and foreground forwarders stop. Idempotent; the attaching caller's scope runs it
   * too when it closes.
   */
  readonly release: Effect.Effect<void>;
  readonly displace?: Effect.Effect<void, never> | undefined;
}

export function requireActiveAttachment(
  activeAttachments: Map<number, ActiveAttachment>,
  ptyProcessId: number,
  attachmentId: symbol | null,
) {
  const active = activeAttachments.get(ptyProcessId);
  if (!active || active.attachmentId !== attachmentId) {
    return Effect.fail(
      new PtyServiceError({
        code: 'session_not_running',
        message: `PTY process ${ptyProcessId} is not running.`,
        ptyProcessId,
      }),
    );
  }
  return Effect.succeed(active);
}

/** Detaches the active attachment of `ptyProcessId` (only `attachmentId`'s, when given) ahead of its caller's scope. */
export function detachActiveAttachment(
  activeAttachments: Map<number, ActiveAttachment>,
  ptyProcessId: number,
  attachmentId?: symbol,
) {
  return Effect.suspend(() => {
    const active = activeAttachments.get(ptyProcessId);
    if (!active) return Effect.void;
    if (attachmentId && active.attachmentId !== attachmentId) return Effect.void;
    return active.release;
  });
}
