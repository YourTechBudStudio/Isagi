import type { CommandLogStreamErrorCode } from '@isagi/contracts';

import { workbenchCopy } from '../../../copy/index.js';
import type { PtyStreamConnectionPhase, PtyStreamNotice } from '../pty-stream/index.js';
import type { CommandLogStreamState } from './stream.js';

export type CommandLogDisplayKind =
  | 'loading'
  | 'replaying'
  | 'streaming'
  | 'frozen'
  | 'closed'
  | 'errored';

export type CommandLogNotice = {
  readonly summary: string;
  readonly detail?: string | undefined;
};

export type CommandLogDisplayState = {
  readonly kind: CommandLogDisplayKind;
  readonly label: string;
  readonly notice: CommandLogNotice | null;
};

export function commandLogDisplayState({
  state,
  rendererWarning,
}: {
  readonly state: CommandLogStreamState;
  readonly rendererWarning: string | null;
}): CommandLogDisplayState {
  const notice = commandLogNotice(state.connection.notice, rendererWarning);
  if (state.connection.notice) {
    return {
      kind: 'errored',
      label: workbenchCopy.commandLogUnavailable,
      notice,
    };
  }

  if (state.exit) {
    return {
      kind: 'frozen',
      label: workbenchCopy.commandLogExit(state.exit.exitCode, state.exit.signal),
      notice,
    };
  }

  const kind = commandLogDisplayKind(state.connection.phase, state.live);
  return {
    kind,
    label: commandLogDisplayLabel(kind),
    notice,
  };
}

function commandLogDisplayKind(
  phase: PtyStreamConnectionPhase,
  live: boolean,
): CommandLogDisplayKind {
  if (phase === 'replaying') {
    return 'replaying';
  }
  if (!live && phase === 'disconnected') {
    return 'closed';
  }
  if (live && phase === 'attached') {
    return 'streaming';
  }
  if (phase === 'errored') {
    return 'errored';
  }
  return 'loading';
}

function commandLogDisplayLabel(kind: CommandLogDisplayKind): string {
  switch (kind) {
    case 'loading':
      return workbenchCopy.commandLogConnecting;
    case 'replaying':
      return workbenchCopy.commandLogReplaying;
    case 'streaming':
      return workbenchCopy.commandLogStreaming;
    case 'frozen':
      return workbenchCopy.commandLogFrozen;
    case 'closed':
      return workbenchCopy.commandLogClosed;
    case 'errored':
      return workbenchCopy.commandLogUnavailable;
  }
}

function commandLogNotice(
  notice: PtyStreamNotice | null,
  rendererWarning: string | null,
): CommandLogNotice | null {
  if (notice?.kind === 'transport') {
    return { summary: notice.message ?? workbenchCopy.commandLogUnavailable };
  }
  if (notice?.kind === 'protocol' && notice.code) {
    return commandLogStreamErrorCopy(notice.code, notice.message);
  }
  return rendererWarning ? { summary: rendererWarning } : null;
}

function commandLogStreamErrorCopy(
  code: CommandLogStreamErrorCode,
  message?: string | undefined,
): CommandLogNotice {
  if (code === 'invalid_message') {
    return { summary: workbenchCopy.commandLogProtocolError };
  }
  if (code === 'read_only_stream') {
    return { summary: workbenchCopy.commandLogReadOnlyRejected };
  }
  return { summary: workbenchCopy.commandLogErrorCode(code), detail: message };
}
