import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PtyWebSocketOutputMessage } from '@isagi/contracts';

import {
  initialPaneConnectionState,
  paneConnectionEventForMessage,
  paneConnectionReducer,
  paneConnectionSnapshot,
  type PaneConnectionEvent,
  type PaneConnectionState,
} from './connection.js';

function run(events: readonly PaneConnectionEvent[]): PaneConnectionState {
  return events.reduce(paneConnectionReducer, initialPaneConnectionState);
}

describe('paneConnectionReducer', () => {
  it('starts idle', () => {
    assert.deepEqual(initialPaneConnectionState, { phase: 'idle', notice: null });
  });

  it('walks a healthy attach through claim, open, replay, live', () => {
    assert.equal(run([{ type: 'attach_started' }]).phase, 'claiming');
    assert.equal(
      run([{ type: 'attach_started' }, { type: 'socket_connecting' }]).phase,
      'attaching',
    );
    assert.equal(
      run([{ type: 'attach_started' }, { type: 'socket_connecting' }, { type: 'socket_open' }])
        .phase,
      'attached',
    );
    assert.equal(run([{ type: 'socket_open' }, { type: 'replay_start' }]).phase, 'replaying');
    assert.equal(
      run([{ type: 'socket_open' }, { type: 'replay_start' }, { type: 'replay_end' }]).phase,
      'attached',
    );
  });

  it('returns to idle on reset', () => {
    assert.deepEqual(
      run([{ type: 'attach_started' }, { type: 'socket_open' }, { type: 'reset' }]),
      initialPaneConnectionState,
    );
  });

  it('marks a clean close as disconnected with no notice', () => {
    assert.deepEqual(run([{ type: 'socket_open' }, { type: 'socket_closed' }]), {
      phase: 'disconnected',
      notice: null,
    });
  });

  it('marks a process exit as disconnected with no active attach request', () => {
    const state = run([{ type: 'socket_open' }, { type: 'session_stopped' }]);

    assert.deepEqual(state, { phase: 'disconnected', notice: null });
    assert.equal(paneConnectionSnapshot(state).attachRequested, false);
  });

  it('keeps the error notice when a close follows it (so "moved" persists)', () => {
    const state = run([
      { type: 'socket_open' },
      { type: 'errored', notice: { kind: 'protocol', code: 'session_attachment_moved' } },
      { type: 'socket_closed' },
    ]);
    assert.equal(state.phase, 'disconnected');
    assert.equal(state.notice?.code, 'session_attachment_moved');
  });

  it('clears the notice when a fresh attach starts', () => {
    const state = run([
      { type: 'errored', notice: { kind: 'transport', message: 'boom' } },
      { type: 'attach_started' },
    ]);
    assert.deepEqual(state, { phase: 'claiming', notice: null });
  });
});

describe('paneConnectionSnapshot', () => {
  it('reports an attach in flight or live as attachRequested', () => {
    for (const phase of ['claiming', 'attaching', 'replaying', 'attached'] as const) {
      assert.equal(paneConnectionSnapshot({ phase, notice: null }).attachRequested, true);
    }
    for (const phase of ['idle', 'disconnected', 'errored'] as const) {
      assert.equal(paneConnectionSnapshot({ phase, notice: null }).attachRequested, false);
    }
  });

  it('surfaces the connection-owned error code to the view', () => {
    const state = run([
      { type: 'errored', notice: { kind: 'protocol', code: 'unsupported_harness' } },
    ]);
    assert.equal(paneConnectionSnapshot(state).code, 'unsupported_harness');
  });
});

describe('paneConnectionEventForMessage', () => {
  it('maps replay boundaries to phase events', () => {
    assert.deepEqual(paneConnectionEventForMessage({ type: 'replay_start', bytes: 10 }), {
      type: 'replay_start',
    });
    assert.deepEqual(paneConnectionEventForMessage({ type: 'replay_end' }), { type: 'replay_end' });
  });

  it('maps a protocol error to an errored event carrying its code', () => {
    const event = paneConnectionEventForMessage({
      type: 'error',
      code: 'session_attachment_moved',
    });
    assert.deepEqual(event, {
      type: 'errored',
      notice: { kind: 'protocol', code: 'session_attachment_moved' },
    });
  });

  it('maps a process exit to a stopped session event', () => {
    assert.deepEqual(paneConnectionEventForMessage({ type: 'exit', exitCode: 0, signal: null }), {
      type: 'session_stopped',
    });
  });

  it('ignores output and session messages (they carry data, not phase)', () => {
    const messages: readonly PtyWebSocketOutputMessage[] = [
      { type: 'output', data: 'hi' },
      { type: 'session', status: 'running' },
    ];
    for (const message of messages) {
      assert.equal(paneConnectionEventForMessage(message), null);
    }
  });
});
