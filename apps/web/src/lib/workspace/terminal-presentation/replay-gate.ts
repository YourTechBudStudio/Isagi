const HELD_LIVE_BYTE_LIMIT = 8 * 1024 * 1024;

export type TerminalReplayGateFailure = {
  readonly type: 'held_live_overflow';
  readonly limitBytes: number;
  readonly heldBytes: number;
  readonly incomingBytes: number;
};

export type TerminalReplayGateState =
  | { readonly phase: 'replaying' }
  | { readonly phase: 'settling'; readonly heldBytes: number }
  | { readonly phase: 'revealed'; readonly drained: boolean }
  | { readonly phase: 'failed'; readonly failure: TerminalReplayGateFailure }
  | { readonly phase: 'cancelled' };

export interface TerminalReplayGate {
  readonly getState: () => TerminalReplayGateState;
  readonly pushOutput: (data: string) => TerminalReplayGateFailure | null;
  readonly beginSettling: () => boolean;
  readonly reveal: () => boolean;
  readonly drain: () => boolean;
  readonly cancel: () => void;
}

/**
 * Attachment-local replay delivery mechanics. It deliberately knows nothing
 * about xterm buffers, renderers, React, or cache lifecycle.
 */
export function createTerminalReplayGate(input: {
  readonly write: (data: string) => void;
  readonly byteLength?: ((data: string) => number) | undefined;
}): TerminalReplayGate {
  const byteLength = input.byteLength ?? utf8ByteLength;
  let state: TerminalReplayGateState = Object.freeze({ phase: 'replaying' });
  let held: string[] = [];

  const failOverflow = (incomingBytes: number): TerminalReplayGateFailure => {
    const heldBytes = state.phase === 'settling' ? state.heldBytes : 0;
    const failure = Object.freeze({
      type: 'held_live_overflow' as const,
      limitBytes: HELD_LIVE_BYTE_LIMIT,
      heldBytes,
      incomingBytes,
    });
    held = [];
    state = Object.freeze({ phase: 'failed', failure });
    return failure;
  };

  return {
    getState: () => state,
    pushOutput(data) {
      if (state.phase === 'failed' || state.phase === 'cancelled') return null;
      if (state.phase === 'replaying') {
        input.write(data);
        return null;
      }
      if (state.phase === 'settling') {
        const incomingBytes = byteLength(data);
        if (incomingBytes > HELD_LIVE_BYTE_LIMIT - state.heldBytes) {
          return failOverflow(incomingBytes);
        }
        held.push(data);
        state = Object.freeze({ phase: 'settling', heldBytes: state.heldBytes + incomingBytes });
        return null;
      }
      input.write(data);
      return null;
    },
    beginSettling() {
      if (state.phase !== 'replaying') return false;
      state = Object.freeze({ phase: 'settling', heldBytes: 0 });
      return true;
    },
    reveal() {
      if (state.phase !== 'settling') return false;
      state = Object.freeze({ phase: 'revealed', drained: false });
      return true;
    },
    drain() {
      if (state.phase !== 'revealed' || state.drained) return false;
      const chunks = held;
      held = [];
      state = Object.freeze({ phase: 'revealed', drained: true });
      for (const chunk of chunks) input.write(chunk);
      return true;
    },
    cancel() {
      if (state.phase === 'cancelled') return;
      held = [];
      state = Object.freeze({ phase: 'cancelled' });
    },
  };
}

function utf8ByteLength(data: string) {
  return new TextEncoder().encode(data).byteLength;
}
