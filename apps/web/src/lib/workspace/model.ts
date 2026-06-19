import type {
  ActiveContext,
  Project as ContractProject,
  SetActiveContextInput,
  WorkspaceSnapshot,
} from '@isagi/contracts';

import { findActiveSurface } from './selectors.js';
import type {
  AccentColor,
  MissingProject,
  Project,
  Surface,
  Worktree,
  WorkspaceSelection,
} from './types.js';

export interface WorkspaceData {
  readonly projects: readonly Project[];
}

const accents = [
  'blue',
  'violet',
  'amber',
  'green',
  'cyan',
] as const satisfies readonly AccentColor[];

export function workspaceDataFromSnapshot(snapshot: WorkspaceSnapshot): WorkspaceData {
  return {
    projects: snapshot.projects.map(projectFromContract),
  };
}

export function projectFromContract(project: ContractProject): Project {
  return {
    ...project,
    glyph: projectGlyph(project.name),
    accent: accents[(project.id - 1) % accents.length] ?? 'blue',
    worktrees: project.worktrees.map((worktree) => ({
      ...worktree,
      attention: 'idle',
      surfaces: worktree.surfaces.map((surface) => ({ ...surface, attention: 'idle' })),
    })),
  };
}

export function replaceProject(projects: readonly Project[], project: Project): readonly Project[] {
  const index = projects.findIndex((candidate) => candidate.id === project.id);
  if (index === -1) {
    return [...projects, project].sort((left, right) => left.id - right.id);
  }
  return projects.map((candidate) => (candidate.id === project.id ? project : candidate));
}

export function activeContextFromSelection(
  selection: WorkspaceSelection,
): SetActiveContextInput | null {
  if (selection.kind !== 'worktree') {
    return null;
  }
  return { projectId: selection.projectId, worktreeId: selection.worktreeId };
}

export function selectionFromActiveContext(
  projects: readonly Project[],
  activeContext: ActiveContext,
): WorkspaceSelection {
  const project =
    activeContext.projectId === null
      ? null
      : projects.find((candidate) => candidate.id === activeContext.projectId);
  if (project?.status === 'missing') {
    return { kind: 'missingProject', projectId: project.id };
  }

  if (activeContext.worktreeId === null) {
    return project ? selectionForProjectRoot(project) : defaultSelection(projects);
  }

  const worktree = project?.worktrees.find(
    (candidate) => candidate.id === activeContext.worktreeId,
  );
  if (project && worktree) {
    return { kind: 'worktree', projectId: project.id, worktreeId: worktree.id };
  }

  if (project) {
    return selectionForProjectRoot(project);
  }

  return defaultSelection(projects);
}

export function reconcileSelection(
  projects: readonly Project[],
  selection: WorkspaceSelection,
): WorkspaceSelection {
  if (selection.kind === 'empty') {
    return selection;
  }

  const project = projects.find((candidate) => candidate.id === selection.projectId);
  if (!project) {
    return defaultSelection(projects);
  }

  if (project.status === 'missing') {
    return { kind: 'missingProject', projectId: project.id };
  }

  if (selection.kind === 'missingProject') {
    return selectionForProjectRoot(project) ?? defaultSelection(projects);
  }

  const worktree = project.worktrees.find((candidate) => candidate.id === selection.worktreeId);
  if (worktree) {
    return selection;
  }

  return selectionForProjectRoot(project) ?? defaultSelection(projects);
}

export function defaultSelection(projects: readonly Project[]): WorkspaceSelection {
  const missingProject = projects.find((project) => project.status === 'missing');
  if (missingProject) {
    return { kind: 'missingProject', projectId: missingProject.id };
  }

  for (const project of projects) {
    if (project.status !== 'present') {
      continue;
    }
    const selection = selectionForProjectRoot(project);
    if (selection.kind === 'worktree') {
      return selection;
    }
  }

  return { kind: 'empty' };
}

export function selectionForProjectRoot(project: Project): WorkspaceSelection {
  if (project.status === 'missing') {
    return { kind: 'missingProject', projectId: project.id };
  }
  const worktree = project.worktrees.find((candidate) => candidate.isRoot) ?? project.worktrees[0];
  if (!worktree) {
    return { kind: 'empty' };
  }
  return { kind: 'worktree', projectId: project.id, worktreeId: worktree.id };
}

export function findWorktree(
  projects: readonly Project[],
  worktreeId: number | null,
): Worktree | null {
  if (!worktreeId) {
    return null;
  }

  for (const project of projects) {
    const worktree = project.worktrees.find((candidate) => candidate.id === worktreeId);
    if (worktree) {
      return worktree;
    }
  }

  return null;
}

export function findMissingProject(
  projects: readonly Project[],
  projectId: number | null,
): MissingProject | null {
  if (!projectId) {
    return null;
  }
  return (
    projects.find(
      (project): project is MissingProject =>
        project.id === projectId && project.status === 'missing',
    ) ?? null
  );
}

export function activeWorktreeId(selection: WorkspaceSelection): number | null {
  return selection.kind === 'worktree' ? selection.worktreeId : null;
}

export function selectedProjectId(selection: WorkspaceSelection): number | null {
  return selection.kind === 'empty' ? null : selection.projectId;
}

export function activeSurfaceForSelection(
  projects: readonly Project[],
  selection: WorkspaceSelection,
): Surface | null {
  const worktree = findWorktree(projects, activeWorktreeId(selection));
  return worktree ? findActiveSurface(worktree) : null;
}

export function resolveActivePaneId(
  panes: readonly { readonly id: number }[],
  storedPaneId: number | null | undefined,
  detailActivePaneId: number | null | undefined,
): number | null {
  if (panes.length === 0) {
    return null;
  }

  if (storedPaneId !== null && storedPaneId !== undefined && paneExists(panes, storedPaneId)) {
    return storedPaneId;
  }

  if (
    detailActivePaneId !== null &&
    detailActivePaneId !== undefined &&
    paneExists(panes, detailActivePaneId)
  ) {
    return detailActivePaneId;
  }

  return panes[0]?.id ?? null;
}

export function resolvePaneFocusAfterDetailChange({
  panes,
  storedPaneId,
  detailActivePaneId,
  previousPaneIds,
}: {
  readonly panes: readonly { readonly id: number }[];
  readonly storedPaneId: number | null | undefined;
  readonly detailActivePaneId: number | null | undefined;
  readonly previousPaneIds: ReadonlySet<number> | null;
}): number | null {
  if (
    detailActivePaneId !== null &&
    detailActivePaneId !== undefined &&
    previousPaneIds !== null &&
    !previousPaneIds.has(detailActivePaneId) &&
    paneExists(panes, detailActivePaneId)
  ) {
    return detailActivePaneId;
  }

  return resolveActivePaneId(panes, storedPaneId, detailActivePaneId);
}

function projectGlyph(name: string) {
  return (
    name
      .split(/[-_\s.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') ||
    name.slice(0, 2).toUpperCase() ||
    'P'
  );
}

function paneExists(panes: readonly { readonly id: number }[], paneId: number) {
  return panes.some((pane) => pane.id === paneId);
}
