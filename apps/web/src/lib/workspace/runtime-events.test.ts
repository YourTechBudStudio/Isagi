import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeEvent } from '@isagi/contracts';

import { queryClient } from '../query/client.js';
import {
  commandLogsQueryKey,
  surfaceDetailQueryKey,
  workspaceQueryKey,
  worktreeCommandsQueryKey,
} from './query-keys.js';
import { handleRuntimeEvent } from './runtime-events.js';

test('runtime session change events invalidate workspace and targeted surface queries', () => {
  queryClient.clear();
  queryClient.setQueryData(workspaceQueryKey, { projects: [] });
  queryClient.setQueryData(surfaceDetailQueryKey(3), { id: 3 });
  queryClient.setQueryData(surfaceDetailQueryKey(99), { id: 99 });

  handleRuntimeEvent(agentSessionChangedEvent());

  assert.equal(queryClient.getQueryState(workspaceQueryKey)?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(surfaceDetailQueryKey(3))?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(surfaceDetailQueryKey(99))?.isInvalidated, false);
  queryClient.clear();
});

test('command change events invalidate command list and targeted logs', () => {
  queryClient.clear();
  queryClient.setQueryData(worktreeCommandsQueryKey(10), { status: 'configured' });
  queryClient.setQueryData(commandLogsQueryKey(10, 'old dev'), { latestRun: null });
  queryClient.setQueryData(commandLogsQueryKey(10, 'other'), { latestRun: null });
  queryClient.setQueryData(worktreeCommandsQueryKey(11), { status: 'configured' });

  handleRuntimeEvent(commandChangedEvent());

  assert.equal(queryClient.getQueryState(worktreeCommandsQueryKey(10))?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(commandLogsQueryKey(10, 'old dev'))?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(commandLogsQueryKey(10, 'other'))?.isInvalidated, false);
  assert.equal(queryClient.getQueryState(worktreeCommandsQueryKey(11))?.isInvalidated, false);
  queryClient.clear();
});

function agentSessionChangedEvent() {
  return {
    id: 'evt_test_1',
    type: 'agent_session_changed',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: {
      agentSessionId: 1,
      worktreeId: 2,
      surfaceId: 3,
      paneId: 4,
      status: 'failed',
      statusReason: 'harness_session_id_missing',
      diagnosticCode: 'harness_session_id_missing',
    },
  } satisfies RuntimeEvent;
}

function commandChangedEvent() {
  return {
    id: 'evt_test_2',
    type: 'command_changed',
    occurredAt: '2026-06-19T00:00:00.000Z',
    payload: {
      worktreeId: 10,
      commandName: 'old dev',
    },
  } satisfies RuntimeEvent;
}
