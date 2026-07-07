import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateAttention, applyAttentionToProjects, useAttentionStore } from '../attention.js';
import type { Project } from '../types.js';
import { workflowPresentationStatus, workflowRunAttention } from '../workflow-derive.js';

test('attention aggregation prioritizes error, then working, then waiting, then idle', () => {
  assert.equal(aggregateAttention(['waiting', 'idle']), 'waiting');
  assert.equal(aggregateAttention(['waiting', 'working']), 'working');
  assert.equal(aggregateAttention(['working', 'error']), 'error');
});

test('attention snapshots replace source state and derive surface and worktree rollups', () => {
  useAttentionStore.getState().replaceSources([
    {
      worktreeId: 10,
      surfaceId: 101,
      paneId: 1001,
      source: { kind: 'agent_session', id: 1 },
      attention: 'waiting',
    },
  ]);
  useAttentionStore.getState().replaceSources([
    {
      worktreeId: 10,
      surfaceId: 102,
      paneId: 1002,
      source: { kind: 'terminal_session', id: 2 },
      attention: 'working',
    },
  ]);

  const [project] = applyAttentionToProjects(
    [projectFixture()],
    useAttentionStore.getState().sourcesByKey,
  );
  const worktree = project?.worktrees[0];

  assert.equal(worktree?.attention, 'working');
  assert.equal(worktree?.surfaces[0]?.attention, 'idle');
  assert.equal(worktree?.surfaces[1]?.attention, 'working');
});

test('workflow surface attention overrides pane attention without changing pane aggregation', () => {
  const [project] = applyAttentionToProjects(
    [projectFixture()],
    {
      'agent_session:1': {
        worktreeId: 10,
        surfaceId: 101,
        paneId: 1001,
        source: { kind: 'agent_session', id: 1 },
        attention: 'waiting',
      },
    },
    {
      77: workflowSummaryFixture({ runId: 77, rootRunId: 77, surfaceId: 101 }),
    },
    { 101: 77 },
  );

  assert.equal(project?.worktrees[0]?.surfaces[0]?.attention, 'working');
});

test('workflow derivations map status to attention signals', () => {
  assert.equal(workflowRunAttention(workflowSummaryFixture({ status: 'running' })), 'working');
  assert.equal(
    workflowRunAttention(
      workflowSummaryFixture({
        status: 'waiting',
        waitKind: 'workflow',
        blockingWait: { kind: 'user_input', runId: 2 },
      }),
    ),
    'waiting',
  );
  assert.equal(workflowRunAttention(workflowSummaryFixture({ paused: true })), 'idle');
  assert.equal(workflowRunAttention(workflowSummaryFixture({ status: 'failed' })), 'error');
  assert.equal(workflowRunAttention(workflowSummaryFixture({ status: 'done' })), null);
});

test('workflow presentation derives user waits and paused state from summary fields', () => {
  assert.equal(
    workflowPresentationStatus(
      workflowSummaryFixture({ status: 'waiting', waitKind: 'agent_turn' }),
    ),
    'driving',
  );
  assert.equal(
    workflowPresentationStatus(
      workflowSummaryFixture({
        status: 'waiting',
        waitKind: 'workflow',
        blockingWait: { kind: 'user_continue', runId: 2 },
      }),
    ),
    'waiting_user',
  );
  assert.equal(
    workflowPresentationStatus(
      workflowSummaryFixture({
        status: 'running',
        waitKind: null,
        blockingWait: { kind: 'user_input', runId: 2 },
      }),
    ),
    'waiting_user',
  );
  assert.equal(
    workflowPresentationStatus(
      workflowSummaryFixture({
        status: 'waiting',
        waitKind: 'workflow',
        blockingWait: { kind: 'user_input', runId: 2 },
        paused: true,
      }),
    ),
    'paused',
  );
});

function workflowSummaryFixture(
  overrides: Partial<import('@isagi/contracts').WorkflowRunSummary> = {},
): import('@isagi/contracts').WorkflowRunSummary {
  return {
    runId: 1,
    rootRunId: 1,
    parentRunId: null,
    workflowKey: 'gate',
    title: 'Gate',
    status: 'running',
    paused: false,
    waitKind: null,
    blockingWait: null,
    worktreeId: 10,
    surfaceId: 101,
    ...overrides,
  };
}

function projectFixture(): Project {
  return {
    id: 1,
    name: 'isagi',
    rootPath: '/repo/isagi',
    status: 'present',
    glyph: 'I',
    accent: 'blue',
    worktrees: [
      {
        id: 10,
        projectId: 1,
        title: 'main',
        path: '/repo/isagi',
        branch: 'main',
        head: 'abcdef0',
        isRoot: true,
        parked: false,
        attention: 'idle',
        surfaces: [
          { id: 101, title: 'Pi', paneKinds: ['agent_session'], attention: 'idle' },
          { id: 102, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
        ],
        activeSurfaceId: null,
      },
    ],
  };
}
