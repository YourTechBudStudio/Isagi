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
import { useWorkflowRunStore } from '../workflow-runs.js';

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

test('an editor status change invalidates its surface detail and nothing else', () => {
  queryClient.clear();
  queryClient.setQueryData(workspaceQueryKey, { projects: [] });
  queryClient.setQueryData(surfaceDetailQueryKey(3), { id: 3 });
  queryClient.setQueryData(surfaceDetailQueryKey(99), { id: 99 });

  handleRuntimeEvent(editorContextChangedEvent());

  assert.equal(queryClient.getQueryState(surfaceDetailQueryKey(3))?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(surfaceDetailQueryKey(99))?.isInvalidated, false);
  // Unlike the session cases: an editor status change alters nothing the
  // workspace snapshot carries. Placement still travels as `surface_changed`.
  assert.equal(queryClient.getQueryState(workspaceQueryKey)?.isInvalidated, false);
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

/**
 * The `exact: true` on the command-list invalidation is load-bearing and is
 * proven here behaviorally rather than by inspecting the options object.
 *
 * `commandLogMetadataQueryKey(10, 'other')` is `['worktree', 10, 'commands',
 * 'log-metadata', 'other']` — a prefix match of the command list's `['worktree',
 * 10, 'commands']`. Dropping `exact: true` would sweep it, and every other
 * command's log metadata, into this refetch. The assertion that it stays
 * uninvalidated is what fails if that happens.
 *
 * The refetch itself is the sole route by which authoritative endpoint facts
 * enter the cache, so invalidating precisely the right key is the client's
 * obligation here; whether TanStack then refetches an active observer is its own.
 */
test('command change events patch status and invalidate command list and targeted metadata', () => {
  queryClient.clear();
  queryClient.setQueryData(worktreeCommandsQueryKey(10), {
    status: 'configured',
    worktreeId: 10,
    commands: [
      {
        name: 'old dev',
        status: 'running',
        ports: [
          {
            port: 5173,
            envVar: null,
            urls: [{ label: 'app', path: '/', url: 'http://localhost:5173/' }],
          },
        ],
      },
    ],
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

test('workflow run events replace, upsert, and clear workflow summaries', () => {
  useWorkflowRunStore.getState().replace([]);

  handleRuntimeEvent({
    id: 'evt_workflow_snapshot',
    type: 'workflow_run_snapshot',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: {
      summaries: [
        workflowSummaryFixture(),
        workflowSummaryFixture({ runId: 77, rootRunId: 77, surfaceId: 4 }),
      ],
    },
  });
  assert.deepEqual(Object.keys(useWorkflowRunStore.getState().runsById), ['42', '77']);
  assert.equal(useWorkflowRunStore.getState().rootRunIdBySurfaceId[3], 42);
  assert.equal(useWorkflowRunStore.getState().rootRunIdBySurfaceId[4], 77);

  handleRuntimeEvent({
    id: 'evt_workflow_changed',
    type: 'workflow_run_changed',
    occurredAt: '2026-06-12T00:00:01.000Z',
    payload: workflowSummaryFixture({
      status: 'waiting',
      waitKind: 'user_continue',
      blockingWait: { kind: 'user_continue', runId: 42 },
      prompt: { runId: 42, questions: [] },
    }),
  });
  assert.equal(useWorkflowRunStore.getState().runsById[42]?.status, 'waiting');

  handleRuntimeEvent({
    id: 'evt_workflow_cleared',
    type: 'workflow_run_cleared',
    occurredAt: '2026-06-12T00:00:02.000Z',
    payload: { runId: 42, rootRunId: 42, surfaceId: 3 },
  });
  assert.deepEqual(Object.keys(useWorkflowRunStore.getState().runsById), ['77']);
  assert.deepEqual(useWorkflowRunStore.getState().rootRunIdBySurfaceId, { 4: 77 });
});

function workflowSummaryFixture(
  overrides: Partial<import('@isagi/contracts').WorkflowRunSummary> = {},
): import('@isagi/contracts').WorkflowRunSummary {
  return {
    runId: 42,
    rootRunId: 42,
    parentRunId: null,
    workflowKey: 'gate',
    title: 'Gate',
    status: 'running',
    paused: false,
    waitKind: null,
    blockingWait: null,
    worktreeId: 9,
    surfaceId: 3,
    ...overrides,
  };
}

function editorContextChangedEvent() {
  return {
    id: 'evt_test_editor',
    type: 'editor_context_changed',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: { editorContextId: 7, worktreeId: 2, surfaceId: 3, paneId: 4 },
  } satisfies RuntimeEvent;
}

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
      statusReason: 'harness_metadata_missing',
      diagnosticCode: 'harness_metadata_missing',
    },
  } satisfies RuntimeEvent;
}

function commandChangedEvent(status: 'failed' | 'running' = 'failed') {
  return {
    id: 'evt_test_2',
    type: 'command_changed',
    occurredAt: '2026-06-19T00:00:00.000Z',
    payload: {
      worktreeId: 10,
      commandName: 'old dev',
      status,
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

/**
 * A status-only event can never authenticate resolved endpoint facts.
 *
 * The restart flow is the case that makes this load-bearing: the intermediate
 * stop is suppressed, so a `running → running` patch arrives while the cache
 * still holds the *dead* incarnation's ports. Keeping them would show a URL that
 * belongs to a process that no longer exists.
 */
test('a patch into running discards the previous incarnation resolved ports', () => {
  queryClient.clear();
  queryClient.setQueryData(worktreeCommandsQueryKey(10), {
    status: 'configured',
    worktreeId: 10,
    commands: [
      {
        name: 'old dev',
        status: 'running',
        ports: [
          {
            port: 5173,
            envVar: 'API_PORT',
            urls: [{ label: 'app', path: '/', url: 'http://localhost:5173/' }],
          },
        ],
      },
    ],
    removedCommands: [],
  });

  handleRuntimeEvent(commandChangedEvent('running'));

  const patched = queryClient.getQueryData(worktreeCommandsQueryKey(10)) as {
    readonly commands: readonly { readonly status: string; readonly ports: unknown }[];
  };
  // Empty, never null: the patcher must not be able to write the authoritative
  // degraded value, or every ordinary launch would flash the "unavailable for
  // this run" notice until the refetch lands.
  assert.deepEqual(patched.commands, [{ name: 'old dev', status: 'running', ports: [] }]);
  queryClient.clear();
});
