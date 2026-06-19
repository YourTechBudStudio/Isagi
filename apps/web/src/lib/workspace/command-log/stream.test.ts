import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commandLogStreamReducer,
  decodeCommandLogStreamMessage,
  initialCommandLogStreamState,
} from './stream.js';

test('command log stream decoder rejects malformed protocol messages', () => {
  assert.equal(decodeCommandLogStreamMessage('{'), null);
  assert.equal(decodeCommandLogStreamMessage(JSON.stringify({ type: 'unknown' })), null);
  assert.deepEqual(decodeCommandLogStreamMessage(JSON.stringify({ type: 'replay_end' })), {
    type: 'replay_end',
  });
});

test('command log stream reducer keeps runtime command status on exit', () => {
  const connecting = commandLogStreamReducer(initialCommandLogStreamState, { type: 'connect' });
  const running = commandLogStreamReducer(connecting, {
    type: 'state',
    message: {
      type: 'command_log_state',
      worktreeId: 10,
      commandName: 'dev',
      status: 'stopped',
      latestRun: null,
      live: true,
    },
  });
  const exited = commandLogStreamReducer(running, {
    type: 'exit',
    exitCode: 143,
    signal: 'SIGTERM',
  });

  assert.equal(exited.phase, 'frozen');
  assert.equal(exited.status, 'stopped');
  assert.deepEqual(exited.exit, { exitCode: 143, signal: 'SIGTERM' });
});

test('command log stream reducer closes replay-only streams after replay', () => {
  const connecting = commandLogStreamReducer(initialCommandLogStreamState, { type: 'connect' });
  const replayOnly = commandLogStreamReducer(connecting, {
    type: 'state',
    message: {
      type: 'command_log_state',
      worktreeId: 10,
      commandName: 'dev',
      status: 'running',
      latestRun: null,
      live: false,
    },
  });
  const replaying = commandLogStreamReducer(replayOnly, { type: 'replay_start' });
  const closed = commandLogStreamReducer(replaying, { type: 'replay_end' });

  assert.equal(closed.phase, 'closed');
  assert.equal(closed.live, false);
});

test('command log stream reducer keeps protocol failures local to stream state', () => {
  const state = commandLogStreamReducer(initialCommandLogStreamState, {
    type: 'error',
    notice: { kind: 'protocol', code: 'invalid_message' },
  });

  assert.equal(state.phase, 'errored');
  assert.deepEqual(state.notice, { kind: 'protocol', code: 'invalid_message' });
});
