import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowRunSummary } from '@isagi/contracts';

import { aggregateAttention, applyAttentionToProjects, useAttentionStore } from '../attention.js';
import type { Project } from '../types.js';
import { workflowPresentationStatus, workflowRunAttention } from '../workflow/derive.js';
import { workflowSummaryFixture } from '../workflow/test-support.js';

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
    [
      workflowSummaryFixture({
        runId: 77,
        status: 'waiting',
        blockingWait: userInputWait(),
      }),
    ],
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
    [workflowSummaryFixture({ runId: 77, status: 'failed' })],
  );

  assert.equal(project?.worktrees[0]?.surfaces[0]?.attention, 'error');
});

test('a workflow on a terminal-only surface still reaches worktree attention', () => {
  for (const [summary, expected] of [
    [
      workflowSummaryFixture({
        runId: 78,
        status: 'waiting',
        blockingWait: userInputWait(),
        attachment: { worktreeId: 10, surfaceId: 102 },
      }),
      'waiting',
    ],
    [
      workflowSummaryFixture({
        runId: 78,
        status: 'failed',
        attachment: { worktreeId: 10, surfaceId: 102 },
      }),
      'error',
    ],
    [
      workflowSummaryFixture({
        runId: 78,
        status: 'running',
        attachment: { worktreeId: 10, surfaceId: 102 },
      }),
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
      [summary],
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
    [
      workflowSummaryFixture({
        runId: 78,
        status: 'done',
        attachment: { worktreeId: 10, surfaceId: 102 },
      }),
    ],
  );

  assert.equal(project?.worktrees[0]?.attention, 'idle');
  assert.equal(project?.worktrees[0]?.surfaces[1]?.attention, 'error');
});

test('workflow derivations map status to attention signals', () => {
  assert.equal(workflowRunAttention(workflowSummaryFixture({ status: 'running' })), 'working');
  assert.equal(
    workflowRunAttention(
      workflowSummaryFixture({ status: 'waiting', blockingWait: userInputWait() }),
    ),
    'waiting',
  );
  assert.equal(workflowRunAttention(workflowSummaryFixture({ paused: true })), 'idle');
  assert.equal(workflowRunAttention(workflowSummaryFixture({ status: 'failed' })), 'error');
  assert.equal(workflowRunAttention(workflowSummaryFixture({ status: 'done' })), null);
  // A blocked run needs someone to look, not to answer, so it signals error rather than waiting.
  assert.equal(workflowRunAttention(workflowSummaryFixture({ status: 'blocked' })), 'error');
  // Cancelled is terminal and deliberate: it draws no attention, exactly like a finished run.
  assert.equal(workflowRunAttention(workflowSummaryFixture({ status: 'cancelled' })), null);
});

test('workflow presentation derives user waits and paused state from summary fields', () => {
  // An agent turn is the workflow waiting on a machine, not on a person.
  assert.equal(
    workflowPresentationStatus(
      workflowSummaryFixture({
        status: 'waiting',
        blockingWait: userInputWait({ kind: 'agent_turn' }),
      }),
    ),
    'driving',
  );
  assert.equal(
    workflowPresentationStatus(
      workflowSummaryFixture({
        status: 'waiting',
        blockingWait: userInputWait({ kind: 'user_continue' }),
      }),
    ),
    'waiting_user',
  );
  assert.equal(
    workflowPresentationStatus(
      workflowSummaryFixture({ status: 'running', blockingWait: userInputWait() }),
    ),
    'waiting_user',
  );
  assert.equal(
    workflowPresentationStatus(
      workflowSummaryFixture({
        status: 'waiting',
        blockingWait: userInputWait(),
        paused: true,
      }),
    ),
    'paused',
  );
  assert.equal(
    workflowPresentationStatus(workflowSummaryFixture({ status: 'blocked' })),
    'blocked',
  );
  assert.equal(
    workflowPresentationStatus(workflowSummaryFixture({ status: 'cancelled' })),
    'cancelled',
  );
});

function userInputWait(
  overrides: Partial<NonNullable<WorkflowRunSummary['blockingWait']>> = {},
): NonNullable<WorkflowRunSummary['blockingWait']> {
  return {
    waitId: 5,
    kind: 'user_input',
    label: null,
    frameId: 1,
    executionId: 1,
    questions: null,
    armedAt: '2026-09-15T10:00:00.000Z',
    ...overrides,
  };
}

function projectFixture(): Project {
  return {
    id: 1,
    name: 'isagi',
    rootPath: '/repo/isagi',
    kind: 'git',
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
