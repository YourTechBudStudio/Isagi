import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  initialPtyStreamConnectionState,
  ptyStreamConnectionActive,
  ptyStreamConnectionEventForMessage,
  ptyStreamConnectionReducer,
  type PtyStreamConnectionEvent,
  type PtyStreamConnectionState,
  type PtyStreamSharedMessage,
} from './connection.js';

function run(events: readonly PtyStreamConnectionEvent[]): PtyStreamConnectionState {
  return events.reduce(ptyStreamConnectionReducer, initialPtyStreamConnectionState);
}

describe('ptyStreamConnectionReducer', () => {
  it('starts idle', () => {
    assert.deepEqual(initialPtyStreamConnectionState, { phase: 'idle', notice: null });
  });

  it('walks a healthy stream through connect, open, replay, live', () => {
    assert.equal(run([{ type: 'connect_started' }]).phase, 'connecting');
    assert.equal(run([{ type: 'connect_started' }, { type: 'socket_open' }]).phase, 'attached');
    assert.equal(run([{ type: 'socket_open' }, { type: 'replay_start' }]).phase, 'replaying');
    assert.equal(
      run([{ type: 'socket_open' }, { type: 'replay_start' }, { type: 'replay_end' }]).phase,
      'attached',
    );
  });

  it('returns to idle on reset', () => {
    assert.deepEqual(
      run([{ type: 'connect_started' }, { type: 'socket_open' }, { type: 'reset' }]),
      initialPtyStreamConnectionState,
    );
  });

  it('marks a clean close as disconnected with no notice', () => {
    assert.deepEqual(run([{ type: 'socket_open' }, { type: 'socket_closed' }]), {
      phase: 'disconnected',
      notice: null,
    });
  });

  it('marks a process exit as disconnected with no active stream', () => {
    const state = run([{ type: 'socket_open' }, { type: 'stream_exited' }]);

    assert.deepEqual(state, { phase: 'disconnected', notice: null });
    assert.equal(ptyStreamConnectionActive(state), false);
  });

  it('keeps an error notice when a close follows it', () => {
    const state = run([
      { type: 'socket_open' },
      { type: 'errored', notice: { kind: 'protocol', code: 'session_attachment_moved' } },
      { type: 'socket_closed' },
    ]);
    assert.equal(state.phase, 'disconnected');
    assert.equal(state.notice?.code, 'session_attachment_moved');
  });

  it('clears the notice when a fresh stream starts', () => {
    const state = run([
      { type: 'errored', notice: { kind: 'transport', message: 'boom' } },
      { type: 'connect_started' },
    ]);
    assert.deepEqual(state, { phase: 'connecting', notice: null });
  });
});

describe('ptyStreamConnectionActive', () => {
  it('reports a stream in flight or live as active', () => {
    for (const phase of ['connecting', 'replaying', 'attached'] as const) {
      assert.equal(ptyStreamConnectionActive({ phase, notice: null }), true);
    }
    for (const phase of ['idle', 'disconnected', 'errored'] as const) {
      assert.equal(ptyStreamConnectionActive({ phase, notice: null }), false);
    }
  });
});

describe('ptyStreamConnectionEventForMessage', () => {
  it('maps replay boundaries to phase events', () => {
    assert.deepEqual(ptyStreamConnectionEventForMessage({ type: 'replay_start', bytes: 10 }), {
      type: 'replay_start',
    });
    assert.deepEqual(ptyStreamConnectionEventForMessage({ type: 'replay_end' }), {
      type: 'replay_end',
    });
  });

  it('maps a protocol error to an errored event carrying its code', () => {
    const event = ptyStreamConnectionEventForMessage({
      type: 'error',
      code: 'session_attachment_moved',
    });
    assert.deepEqual(event, {
      type: 'errored',
      notice: { kind: 'protocol', code: 'session_attachment_moved' },
    });
  });

  it('maps a process exit to a stream-exited event', () => {
    assert.deepEqual(
      ptyStreamConnectionEventForMessage({ type: 'exit', exitCode: 0, signal: null }),
      {
        type: 'stream_exited',
      },
    );
  });

  it('ignores output messages', () => {
    const messages: readonly PtyStreamSharedMessage[] = [{ type: 'output', data: 'hi' }];
    for (const message of messages) {
      assert.equal(ptyStreamConnectionEventForMessage(message), null);
    }
  });
});
