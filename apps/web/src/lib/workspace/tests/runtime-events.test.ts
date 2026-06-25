import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeEvent } from '@isagi/contracts';

import { queryClient } from '../../query/client.js';
import {
  commandLogMetadataQueryKey,
  surfaceDetailQueryKey,
  workspaceQueryKey,
  worktreeCommandsQueryKey,
} from '../query-keys.js';
import { handleRuntimeEvent } from '../runtime-events.js';
import { useWorkspaceStore } from '../store.js';
import { useWorkflowSurfaceStore } from '../workflow-surface.js';

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

test('surface pane delete events invalidate detail and clear matching active pane', () => {
  queryClient.clear();
  queryClient.setQueryData(workspaceQueryKey, { projects: [] });
  queryClient.setQueryData(surfaceDetailQueryKey(3), { id: 3 });
  useWorkspaceStore.setState({
    activeSurfaceByWorktreeId: { 2: 3 },
    activePaneBySurfaceId: { 3: 4, 99: 100 },
  });

  handleRuntimeEvent(surfacePaneDeletedEvent());

  assert.equal(queryClient.getQueryState(workspaceQueryKey)?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(surfaceDetailQueryKey(3))?.isInvalidated, true);
  assert.deepEqual(useWorkspaceStore.getState().activeSurfaceByWorktreeId, { 2: 3 });
  assert.deepEqual(useWorkspaceStore.getState().activePaneBySurfaceId, { 99: 100 });
  queryClient.clear();
});

test('surface deleted events remove detail cache and clear active surface state', () => {
  queryClient.clear();
  queryClient.setQueryData(workspaceQueryKey, { projects: [] });
  queryClient.setQueryData(surfaceDetailQueryKey(3), { id: 3 });
  useWorkspaceStore.setState({
    activeSurfaceByWorktreeId: { 2: 3, 20: 30 },
    activePaneBySurfaceId: { 3: 4, 99: 100 },
  });

  handleRuntimeEvent(surfaceDeletedEvent());

  assert.equal(queryClient.getQueryState(workspaceQueryKey)?.isInvalidated, true);
  assert.equal(queryClient.getQueryData(surfaceDetailQueryKey(3)), undefined);
  assert.deepEqual(useWorkspaceStore.getState().activeSurfaceByWorktreeId, { 20: 30 });
  assert.deepEqual(useWorkspaceStore.getState().activePaneBySurfaceId, { 99: 100 });
  queryClient.clear();
});

test('command change events patch status and invalidate command list and targeted metadata', () => {
  queryClient.clear();
  queryClient.setQueryData(worktreeCommandsQueryKey(10), {
    status: 'configured',
    worktreeId: 10,
    commands: [{ name: 'old dev', status: 'running', ports: [5173] }],
    removedCommands: [],
  });
  queryClient.setQueryData(commandLogMetadataQueryKey(10, 'old dev'), { latestRun: null });
  queryClient.setQueryData(commandLogMetadataQueryKey(10, 'other'), { latestRun: null });
  queryClient.setQueryData(worktreeCommandsQueryKey(11), {
    status: 'configured',
    worktreeId: 11,
    commands: [],
    removedCommands: [],
  });

  handleRuntimeEvent(commandChangedEvent());

  const patched = queryClient.getQueryData(worktreeCommandsQueryKey(10)) as {
    readonly commands: readonly { readonly name: string; readonly status: string }[];
  };
  assert.deepEqual(patched.commands, [{ name: 'old dev', status: 'failed', ports: [] }]);
  assert.equal(queryClient.getQueryState(worktreeCommandsQueryKey(10))?.isInvalidated, true);
  assert.equal(
    queryClient.getQueryState(commandLogMetadataQueryKey(10, 'old dev'))?.isInvalidated,
    true,
  );
  assert.equal(
    queryClient.getQueryState(commandLogMetadataQueryKey(10, 'other'))?.isInvalidated,
    false,
  );
  assert.equal(queryClient.getQueryState(worktreeCommandsQueryKey(11))?.isInvalidated, false);
  queryClient.clear();
});

test('command change events patch managed command status when config is malformed', () => {
  queryClient.clear();
  queryClient.setQueryData(worktreeCommandsQueryKey(10), {
    status: 'config_error',
    worktreeId: 10,
    diagnostic: { code: 'command_config_invalid', path: '.isagi/config.yaml', message: 'bad' },
    managedCommands: [{ name: 'old dev', status: 'running', ports: [] }],
  });

  handleRuntimeEvent(commandChangedEvent());

  const patched = queryClient.getQueryData(worktreeCommandsQueryKey(10)) as {
    readonly managedCommands: readonly { readonly name: string; readonly status: string }[];
  };
  assert.deepEqual(patched.managedCommands, [{ name: 'old dev', status: 'failed', ports: [] }]);
  queryClient.clear();
});

test('workflow surface events replace, upsert, and clear workflow summaries', () => {
  useWorkflowSurfaceStore.getState().replace([]);

  handleRuntimeEvent({
    id: 'evt_workflow_snapshot',
    type: 'workflow_surface_snapshot',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: {
      summaries: [{ surfaceId: 3, rootRunId: 42, status: 'driving', title: 'Gate' }],
    },
  });
  assert.deepEqual(Object.keys(useWorkflowSurfaceStore.getState().summariesBySurfaceId), ['3']);

  handleRuntimeEvent({
    id: 'evt_workflow_changed',
    type: 'workflow_surface_changed',
    occurredAt: '2026-06-12T00:00:01.000Z',
    payload: {
      surfaceId: 3,
      rootRunId: 42,
      status: 'waiting_user',
      title: 'Gate',
      prompt: { runId: 42, questions: [] },
    },
  });
  assert.equal(useWorkflowSurfaceStore.getState().summariesBySurfaceId[3]?.status, 'waiting_user');

  handleRuntimeEvent({
    id: 'evt_workflow_cleared',
    type: 'workflow_surface_cleared',
    occurredAt: '2026-06-12T00:00:02.000Z',
    payload: { surfaceId: 3 },
  });
  assert.deepEqual(useWorkflowSurfaceStore.getState().summariesBySurfaceId, {});
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
      status: 'failed',
    },
  } satisfies RuntimeEvent;
}

function surfacePaneDeletedEvent() {
  return {
    id: 'evt_test_3',
    type: 'surface_changed',
    occurredAt: '2026-06-19T00:00:00.000Z',
    payload: {
      worktreeId: 2,
      surfaceId: 3,
      change: 'pane_deleted',
      deletedPaneIds: [4],
    },
  } satisfies RuntimeEvent;
}

function surfaceDeletedEvent() {
  return {
    id: 'evt_test_4',
    type: 'surface_changed',
    occurredAt: '2026-06-19T00:00:00.000Z',
    payload: {
      worktreeId: 2,
      surfaceId: 3,
      change: 'deleted',
      deletedPaneIds: [4],
    },
  } satisfies RuntimeEvent;
}
