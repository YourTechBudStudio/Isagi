import type { CommandLogStreamErrorCode } from '@isagi/contracts';

import { workbenchCopy } from '../../../copy/index.js';
import type { PtyStreamConnectionPhase, PtyStreamNotice } from '../pty-stream/index.js';
import type { CommandLogStreamState } from './stream.js';

const commandLogStreamErrorCodes = new Set<string>([
  'invalid_message',
  'stream_superseded',
  'backend_unavailable',
  'backend_session_missing',
  'backend_attach_failed',
  'log_read_failed',
  'pty_state_load_failed',
  'read_only_stream',
  'worktree_not_found',
  'command_config_invalid',
  'command_not_found',
  'unknown',
]);

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
  if (live && phase === 'disconnected') {
    return 'errored';
  }
  if (live && phase === 'attached') {
    return 'streaming';
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
      return workbenchCopy.commandLogDropped;
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
    const code = isCommandLogStreamErrorCode(notice.code) ? notice.code : 'unknown';
    return commandLogStreamErrorCopy(code, notice.message ?? notice.code);
  }
  return rendererWarning ? { summary: rendererWarning } : null;
}

function isCommandLogStreamErrorCode(code: string): code is CommandLogStreamErrorCode {
  return commandLogStreamErrorCodes.has(code);
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
  return { summary: workbenchCopy.commandLogStreamError(code), detail: message ?? code };
}
