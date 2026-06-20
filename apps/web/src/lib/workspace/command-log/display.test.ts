import assert from 'node:assert/strict';
import test from 'node:test';

import { workbenchCopy } from '../../../copy/index.js';
import { commandLogDisplayState } from './display.js';
import type { CommandLogStreamState } from './stream.js';

const baseState: CommandLogStreamState = {
  connection: { phase: 'connecting', notice: null },
  status: null,
  latestRun: null,
  live: false,
  exit: null,
};

function display(state: Partial<CommandLogStreamState>) {
  return commandLogDisplayState({
    state: { ...baseState, ...state },
    rendererWarning: null,
  });
}

test('command log display gives notice precedence over terminal close phase', () => {
  const state = display({
    connection: {
      phase: 'disconnected',
      notice: { kind: 'protocol', code: 'stream_superseded', message: 'moved' },
    },
    live: true,
    exit: { exitCode: 0, signal: null },
  });

  assert.equal(state.kind, 'errored');
  assert.equal(state.label, workbenchCopy.commandLogUnavailable);
  assert.deepEqual(state.notice, {
    summary: workbenchCopy.commandLogErrorCode('stream_superseded'),
    detail: 'moved',
  });
});

test('command log display freezes exited streams before reading disconnected phase', () => {
  const state = display({
    connection: { phase: 'disconnected', notice: null },
    live: false,
    exit: { exitCode: 143, signal: 'SIGTERM' },
  });

  assert.equal(state.kind, 'frozen');
  assert.equal(state.label, workbenchCopy.commandLogExit(143, 'SIGTERM'));
});

test('command log display closes non-live streams after the socket disconnects', () => {
  const state = display({
    connection: { phase: 'disconnected', notice: null },
    live: false,
  });

  assert.equal(state.kind, 'closed');
  assert.equal(state.label, workbenchCopy.commandLogClosed);
});

test('command log display distinguishes replaying, live streaming, and loading states', () => {
  assert.equal(
    display({ connection: { phase: 'replaying', notice: null }, live: false }).kind,
    'replaying',
  );
  assert.equal(
    display({ connection: { phase: 'attached', notice: null }, live: true }).kind,
    'streaming',
  );
  assert.equal(
    display({ connection: { phase: 'attached', notice: null }, live: false }).kind,
    'loading',
  );
});
