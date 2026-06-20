import type { PtyStreamErrorCode } from '@isagi/contracts';

export type PtyStreamNotice = {
  readonly kind: 'protocol' | 'transport';
  readonly code?: PtyStreamErrorCode | undefined;
  readonly message?: string | undefined;
};

export type PtyStreamConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'attached'
  | 'replaying'
  | 'disconnected'
  | 'errored';

export type PtyStreamConnectionState = {
  readonly phase: PtyStreamConnectionPhase;
  readonly notice: PtyStreamNotice | null;
};

export const initialPtyStreamConnectionState: PtyStreamConnectionState = {
  phase: 'idle',
  notice: null,
};

export type PtyStreamConnectionEvent =
  | { readonly type: 'reset' }
  | { readonly type: 'connect_started' }
  | { readonly type: 'socket_open' }
  | { readonly type: 'replay_start' }
  | { readonly type: 'replay_end' }
  | { readonly type: 'stream_exited' }
  | { readonly type: 'socket_closed' }
  | { readonly type: 'errored'; readonly notice: PtyStreamNotice };

export function ptyStreamConnectionReducer(
  state: PtyStreamConnectionState,
  event: PtyStreamConnectionEvent,
): PtyStreamConnectionState {
  switch (event.type) {
    case 'reset':
      return initialPtyStreamConnectionState;
    case 'connect_started':
      return { phase: 'connecting', notice: null };
    case 'socket_open':
      return { phase: 'attached', notice: null };
    case 'replay_start':
      return { phase: 'replaying', notice: state.notice };
    case 'replay_end':
      return { phase: 'attached', notice: state.notice };
    case 'stream_exited':
      return { phase: 'disconnected', notice: state.notice };
    case 'socket_closed':
      return { phase: 'disconnected', notice: state.notice };
    case 'errored':
      return { phase: 'errored', notice: event.notice };
  }
}

export function ptyStreamConnectionActive(state: PtyStreamConnectionState): boolean {
  return state.phase === 'connecting' || state.phase === 'replaying' || state.phase === 'attached';
}

export type PtyStreamSharedMessage =
  | { readonly type: 'replay_start'; readonly bytes: number }
  | { readonly type: 'output'; readonly data: string; readonly replay?: boolean | undefined }
  | { readonly type: 'replay_end' }
  | { readonly type: 'exit'; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly type: 'error'; readonly code: PtyStreamErrorCode; readonly message?: string };

export function ptyStreamConnectionEventForMessage(
  message: PtyStreamSharedMessage,
): PtyStreamConnectionEvent | null {
  switch (message.type) {
    case 'replay_start':
      return { type: 'replay_start' };
    case 'replay_end':
      return { type: 'replay_end' };
    case 'error':
      return {
        type: 'errored',
        notice: { kind: 'protocol', code: message.code, message: message.message },
      };
    case 'exit':
      return { type: 'stream_exited' };
    case 'output':
      return null;
  }
}
