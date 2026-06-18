import { Effect } from 'effect';

import { PtyServiceError, type BackendAttachment } from '../types.js';

export interface ActiveAttachment {
  readonly ptyProcessId: number;
  readonly attachmentId: symbol;
  readonly attachment: BackendAttachment;
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

export function detachActiveAttachment(
  activeAttachments: Map<number, ActiveAttachment>,
  ptyProcessId: number,
  attachmentId?: symbol,
) {
  return Effect.gen(function* () {
    const active = activeAttachments.get(ptyProcessId);
    if (!active) {
      return;
    }
    if (attachmentId && active.attachmentId !== attachmentId) {
      return;
    }
    activeAttachments.delete(ptyProcessId);
    yield* active.attachment.detach;
    console.info(`[runtime] PTY websocket detach ptyProcessId=${ptyProcessId}`);
  });
}
