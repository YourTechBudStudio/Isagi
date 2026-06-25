import assert from 'node:assert/strict';
import test from 'node:test';

import type { SurfaceDetail } from '@isagi/contracts';

import type { Project, Surface } from '../workspace/types.js';
import { buildPaletteContext, workflowContextFromSurfaceDetail } from './context.js';

test('palette context carries active surface and frontend active pane target', () => {
  const surfaceA = surface({ id: 101, title: 'Agent', paneKinds: ['agent_session'] });
  const surfaceB = surface({ id: 102, title: 'Terminal', paneKinds: ['terminal_session'] });
  const projects = [project({ surfaces: [surfaceA, surfaceB], activeSurfaceId: surfaceA.id })];

  const ctx = buildPaletteContext(projects, 10, {
    activeSurfaceByWorktreeId: { 10: surfaceB.id },
    activePaneBySurfaceId: { [surfaceB.id]: 501 },
  });

  assert.equal(ctx.activeProject?.id, 1);
  assert.equal(ctx.activeWorktree?.id, 10);
  assert.equal(ctx.activeSurface?.id, surfaceB.id);
  assert.equal(ctx.activePaneId, 501);
});

test('palette context ignores stale active surface overrides', () => {
  const surfaceA = surface({ id: 101, title: 'Agent', paneKinds: ['agent_session'] });
  const projects = [project({ surfaces: [surfaceA], activeSurfaceId: surfaceA.id })];

  const ctx = buildPaletteContext(projects, 10, {
    activeSurfaceByWorktreeId: { 10: 999 },
    activePaneBySurfaceId: { [surfaceA.id]: 501 },
  });

  assert.equal(ctx.activeSurface?.id, surfaceA.id);
  assert.equal(ctx.activePaneId, 501);
});

test('workflow launch context carries focused agent session from surface detail', () => {
  const context = workflowContextFromSurfaceDetail({
    worktreeId: 10,
    surfaceId: 101,
    activePaneId: 501,
    detail: surfaceDetail({ activePaneId: 501, paneKind: 'agent_session' }),
  });

  assert.deepEqual(context, {
    worktreeId: 10,
    surfaceId: 101,
    paneId: 501,
    agentSessionId: 701,
  });
});

test('workflow launch context keeps pane target but nulls non-agent sessions', () => {
  const context = workflowContextFromSurfaceDetail({
    worktreeId: 10,
    surfaceId: 101,
    activePaneId: 501,
    detail: surfaceDetail({ activePaneId: 501, paneKind: 'terminal_session' }),
  });

  assert.deepEqual(context, {
    worktreeId: 10,
    surfaceId: 101,
    paneId: 501,
    agentSessionId: null,
  });
});

test('workflow launch context nulls stale pane targets missing from surface detail', () => {
  const context = workflowContextFromSurfaceDetail({
    worktreeId: 10,
    surfaceId: 101,
    activePaneId: 999,
    detail: surfaceDetail({ activePaneId: 501, paneKind: 'agent_session' }),
  });

  assert.deepEqual(context, {
    worktreeId: 10,
    surfaceId: 101,
    paneId: 999,
    agentSessionId: null,
  });
});

function surface(input: {
  readonly id: number;
  readonly title: string;
  readonly paneKinds: Surface['paneKinds'];
}): Surface {
  return {
    id: input.id,
    title: input.title,
    paneKinds: input.paneKinds,
    attention: 'idle',
  };
}

function project(input: {
  readonly surfaces: readonly Surface[];
  readonly activeSurfaceId: number | null;
}): Project {
  return {
    id: 1,
    name: 'isagi',
    rootPath: '/repo/isagi',
    glyph: 'IS',
    accent: 'blue',
    status: 'present',
    worktrees: [
      {
        id: 10,
        projectId: 1,
        title: 'main',
        path: '/repo/isagi',
        branch: 'main',
        head: 'abcdef0',
        isRoot: true,
        attention: 'idle',
        parked: false,
        surfaces: input.surfaces,
        activeSurfaceId: input.activeSurfaceId,
      },
    ],
  };
}

function surfaceDetail(input: {
  readonly activePaneId: number;
  readonly paneKind: 'agent_session' | 'terminal_session';
}): SurfaceDetail {
  return {
    id: 101,
    worktreeId: 10,
    title: 'Agent',
    activePaneId: input.activePaneId,
    layout: { kind: 'leaf', nodeId: 'pane-501', paneId: 501, collapsed: false },
    panes: [
      {
        id: 501,
        surfaceId: 101,
        title: 'Pane',
        sortOrder: 0,
        session:
          input.paneKind === 'agent_session'
            ? {
                kind: 'agent_session',
                agentSession: {
                  id: 701,
                  paneId: 501,
                  worktreeId: 10,
                  harness: 'codex',
                  cwd: '/repo/isagi',
                  harnessSessionId: 'harness-701',
                  status: 'running',
                  statusReason: null,
                  recoveryAction: 'resume_existing',
                  diagnosticCode: null,
                  diagnosticDetail: null,
                  createdAt: '2026-06-18T00:00:00.000Z',
                  updatedAt: '2026-06-18T00:00:00.000Z',
                  lastSeenAt: '2026-06-18T00:00:00.000Z',
                },
              }
            : {
                kind: 'terminal_session',
                terminalSession: {
                  id: 801,
                  paneId: 501,
                  worktreeId: 10,
                  cwd: '/repo/isagi',
                  shellCommand: 'zsh',
                  shellArgs: [],
                  status: 'running',
                  statusReason: null,
                  diagnosticCode: null,
                  diagnosticDetail: null,
                  createdAt: '2026-06-18T00:00:00.000Z',
                  updatedAt: '2026-06-18T00:00:00.000Z',
                  lastSeenAt: '2026-06-18T00:00:00.000Z',
                },
              },
      },
    ],
  };
}
