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

test('attention snapshots replace source state without rolling terminal-only surfaces into worktrees', () => {
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

  assert.equal(worktree?.attention, 'idle');
  assert.equal(worktree?.surfaces[0]?.attention, 'idle');
  assert.equal(worktree?.surfaces[1]?.attention, 'working');
});

test('terminal-only surface errors stay visible on the surface without updating worktree attention', () => {
  const [project] = applyAttentionToProjects([projectFixture()], {
    'terminal_session:2': {
      worktreeId: 10,
      surfaceId: 102,
      paneId: 1002,
      source: { kind: 'terminal_session', id: 2 },
      attention: 'error',
    },
  });

  const worktree = project?.worktrees[0];
  assert.equal(worktree?.attention, 'idle');
  assert.equal(worktree?.surfaces[1]?.attention, 'error');
});

test('a working pane wins over a waiting pane within the same surface', () => {
  const [project] = applyAttentionToProjects([projectFixture()], {
    'agent_session:1': {
      worktreeId: 10,
      surfaceId: 101,
      paneId: 1001,
      source: { kind: 'agent_session', id: 1 },
      attention: 'waiting',
    },
    'agent_session:2': {
      worktreeId: 10,
      surfaceId: 101,
      paneId: 1002,
      source: { kind: 'agent_session', id: 2 },
      attention: 'working',
    },
  });

  assert.equal(project?.worktrees[0]?.attention, 'working');
  assert.equal(project?.worktrees[0]?.surfaces[0]?.attention, 'working');
});

test('a mixed agent and terminal surface still contributes to worktree attention', () => {
  const fixture = projectFixture();
  const [project] = applyAttentionToProjects(
    [
      {
        ...fixture,
        worktrees: fixture.worktrees.map((worktree) => ({
          ...worktree,
          surfaces: worktree.surfaces.map((surface) =>
            surface.id === 101
              ? { ...surface, paneKinds: ['agent_session', 'terminal_session'] }
              : surface,
          ),
        })),
      },
    ],
    {
      'terminal_session:2': {
        worktreeId: 10,
        surfaceId: 101,
        paneId: 1002,
        source: { kind: 'terminal_session', id: 2 },
        attention: 'error',
      },
    },
  );

  assert.equal(project?.worktrees[0]?.attention, 'error');
  assert.equal(project?.worktrees[0]?.surfaces[0]?.attention, 'error');
});

test('surface attention aggregates workflow and pane signals through the shared hierarchy', () => {
  const [project] = applyAttentionToProjects(
    [projectFixture()],
    {
      'agent_session:1': {
        worktreeId: 10,
        surfaceId: 101,
        paneId: 1001,
        source: { kind: 'agent_session', id: 1 },
        attention: 'working',
      },
    },
    {
      77: workflowSummaryFixture({
        runId: 77,
        rootRunId: 77,
        surfaceId: 101,
        status: 'waiting',
        waitKind: 'workflow',
        blockingWait: { kind: 'user_input', runId: 77 },
      }),
    },
    { 101: 77 },
  );

  assert.equal(project?.worktrees[0]?.surfaces[0]?.attention, 'working');
});

test('workflow errors remain higher priority than working panes', () => {
  const [project] = applyAttentionToProjects(
    [projectFixture()],
    {
      'agent_session:1': {
        worktreeId: 10,
        surfaceId: 101,
        paneId: 1001,
        source: { kind: 'agent_session', id: 1 },
        attention: 'working',
      },
    },
    {
      77: workflowSummaryFixture({
        runId: 77,
        rootRunId: 77,
        surfaceId: 101,
        status: 'failed',
      }),
    },
    { 101: 77 },
  );

  assert.equal(project?.worktrees[0]?.surfaces[0]?.attention, 'error');
});

test('a workflow on a terminal-only surface still reaches worktree attention', () => {
  for (const [summary, expected] of [
    [
      workflowSummaryFixture({
        runId: 78,
        rootRunId: 78,
        surfaceId: 102,
        status: 'waiting',
        waitKind: 'workflow',
        blockingWait: { kind: 'user_input', runId: 78 },
      }),
      'waiting',
    ],
    [
      workflowSummaryFixture({ runId: 78, rootRunId: 78, surfaceId: 102, status: 'failed' }),
      'error',
    ],
    [
      workflowSummaryFixture({ runId: 78, rootRunId: 78, surfaceId: 102, status: 'running' }),
      'working',
    ],
  ] as const) {
    const [project] = applyAttentionToProjects(
      [projectFixture()],
      {
        'terminal_session:2': {
          worktreeId: 10,
          surfaceId: 102,
          paneId: 1002,
          source: { kind: 'terminal_session', id: 2 },
          attention: 'working',
        },
      },
      { 78: summary },
      { 102: 78 },
    );

    assert.equal(project?.worktrees[0]?.attention, expected);
    assert.equal(
      project?.worktrees[0]?.surfaces[1]?.attention,
      expected === 'waiting' ? 'working' : expected,
    );
  }
});

test('a finished workflow on a terminal-only surface leaves the worktree idle', () => {
  const [project] = applyAttentionToProjects(
    [projectFixture()],
    {
      'terminal_session:2': {
        worktreeId: 10,
        surfaceId: 102,
        paneId: 1002,
        source: { kind: 'terminal_session', id: 2 },
        attention: 'error',
      },
    },
    { 78: workflowSummaryFixture({ runId: 78, rootRunId: 78, surfaceId: 102, status: 'done' }) },
    { 102: 78 },
  );

  assert.equal(project?.worktrees[0]?.attention, 'idle');
  assert.equal(project?.worktrees[0]?.surfaces[1]?.attention, 'error');
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
