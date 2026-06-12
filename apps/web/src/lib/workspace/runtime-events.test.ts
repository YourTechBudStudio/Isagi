import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeEvent } from '@isagi/contracts';

import { queryClient } from '../query/client.js';
import { surfaceDetailQueryKey, workspaceQueryKey } from './queries.js';
import { handleRuntimeEvent } from './runtime-events.js';

test('runtime PTY session change events invalidate workspace and targeted surface queries', () => {
  queryClient.clear();
  queryClient.setQueryData(workspaceQueryKey, { projects: [] });
  queryClient.setQueryData(surfaceDetailQueryKey(3), { id: 3 });
  queryClient.setQueryData(surfaceDetailQueryKey(99), { id: 99 });

  handleRuntimeEvent(ptySessionChangedEvent());

  assert.equal(queryClient.getQueryState(workspaceQueryKey)?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(surfaceDetailQueryKey(3))?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(surfaceDetailQueryKey(99))?.isInvalidated, false);
  queryClient.clear();
});

function ptySessionChangedEvent() {
  return {
    id: 'evt_test_1',
    type: 'pty_session_changed',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: {
      ptySessionId: 1,
      worktreeId: 2,
      surfaceId: 3,
      paneId: 4,
      previousStatus: 'running',
      status: 'failed',
      previousStatusReason: null,
      statusReason: 'backend_session_missing',
    },
  } satisfies RuntimeEvent;
}
