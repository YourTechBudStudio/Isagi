import type { AgentHarness, SurfaceDetail, WorkflowStartContext } from '@isagi/contracts';

import type { Project, Worktree } from '../workspace/types.js';
import type { PaletteContext } from './types.js';

function findWorktreeProject(
  projects: readonly Project[],
  worktree: Worktree | null,
): Project | null {
  if (!worktree) {
    return null;
  }
  return projects.find((project) => project.worktrees.some((s) => s.id === worktree.id)) ?? null;
}

export function buildPaletteContext(
  projects: readonly Project[],
  activeWorktreeId: number | null,
  options: {
    readonly launchableHarnesses: readonly AgentHarness[];
    readonly activeSurfaceByWorktreeId?: Readonly<Record<number, number>>;
    readonly activePaneBySurfaceId?: Readonly<Record<number, number>>;
    readonly workflowDescriptors?: PaletteContext['workflowDescriptors'];
    readonly activeSurfaceWorkflowSummary?: PaletteContext['activeSurfaceWorkflowSummary'];
    readonly workflowFailure?: PaletteContext['workflowFailure'];
  },
): PaletteContext {
  const activeWorktree =
    projects
      .flatMap((project) => project.worktrees)
      .find((worktree) => worktree.id === activeWorktreeId) ?? null;
  const storedActiveSurfaceId = activeWorktree
    ? options.activeSurfaceByWorktreeId?.[activeWorktree.id]
    : null;
  const storedActiveSurface =
    activeWorktree?.surfaces.find((surface) => surface.id === storedActiveSurfaceId) ?? null;
  const runtimeActiveSurface =
    activeWorktree?.surfaces.find((surface) => surface.id === activeWorktree.activeSurfaceId) ??
    null;
  const activeSurface = storedActiveSurface ?? runtimeActiveSurface;

  return {
    projects,
    activeWorktree,
    activeProject: findWorktreeProject(projects, activeWorktree),
    activeSurface,
    activePaneId: activeSurface
      ? (options.activePaneBySurfaceId?.[activeSurface.id] ?? null)
      : null,
    launchableHarnesses: options.launchableHarnesses,
    workflowDescriptors: options.workflowDescriptors,
    activeSurfaceWorkflowSummary: options.activeSurfaceWorkflowSummary,
    workflowFailure: options.workflowFailure,
  };
}

export function workflowContextFromSurfaceDetail(input: {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly activePaneId: number | null;
  readonly detail: SurfaceDetail;
}): WorkflowStartContext {
  const paneId = input.activePaneId ?? input.detail.activePaneId;
  const pane =
    paneId === null
      ? null
      : (input.detail.panes.find((candidate) => candidate.id === paneId) ?? null);
  const agentSessionId =
    pane?.session?.kind === 'agent_session' ? pane.session.agentSession.id : null;

  return {
    worktreeId: input.worktreeId,
    surfaceId: input.surfaceId,
    paneId,
    agentSessionId,
  };
}
