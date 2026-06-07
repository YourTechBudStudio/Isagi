import { GitBranch } from 'lucide-react';

import { useWorkspaceStore } from '../../workspace/store.js';
import type { Project, Worktree } from '../../workspace/types.js';
import type { Option, PaletteCommand } from '../types.js';

interface ExistingWorktreePayload {
  readonly kind: 'existing_worktree';
  readonly projectId: number;
  readonly worktreeId: number;
}

export const openWorktreeCommand: PaletteCommand = {
  id: 'open-worktree',
  label: 'Open Worktree',
  icon: GitBranch,
  group: 'global',
  available: (ctx) => presentProjects(ctx.projects).some((project) => project.worktrees.length > 0),
  args: [
    {
      kind: 'select',
      key: 'projectId',
      label: 'Project',
      options: (ctx) =>
        presentProjects(ctx.projects).map((project) => ({
          value: String(project.id),
          label: project.name,
          hint: project.rootPath,
          isDefault: project.id === ctx.activeProject?.id,
        })),
    },
    {
      kind: 'select',
      key: 'worktreeId',
      label: 'Worktree',
      defaultSelection: 'none',
      emptyHint: 'Type to filter existing worktrees, then choose one.',
      options: (ctx, values): readonly Option<ExistingWorktreePayload>[] => {
        const projectId = Number(values.projectId);
        const project = presentProjects(ctx.projects).find(
          (candidate) => candidate.id === projectId,
        );
        if (!project) {
          return [];
        }

        return [...project.worktrees]
          .sort((left, right) =>
            worktreeOptionLabel(left).localeCompare(worktreeOptionLabel(right)),
          )
          .map((worktree) => ({
            value: String(worktree.id),
            label: worktreeOptionLabel(worktree),
            hint: worktree.branch ? 'branch · already open' : 'commit · already open',
            payload: {
              kind: 'existing_worktree',
              projectId: project.id,
              worktreeId: worktree.id,
            },
          }));
      },
    },
  ],
  run: (values, ctx, payloads) => {
    const selected = payloads?.worktreeId;
    if (isExistingWorktreePayload(selected)) {
      useWorkspaceStore.getState().selectWorktree(selected.projectId, selected.worktreeId);
      return;
    }

    const projectId = Number(values.projectId);
    const worktreeId = Number(values.worktreeId);
    const project = presentProjects(ctx.projects).find((candidate) => candidate.id === projectId);
    const worktree = project?.worktrees.find((candidate) => candidate.id === worktreeId);
    if (project && worktree) {
      useWorkspaceStore.getState().selectWorktree(project.id, worktree.id);
    }
  },
};

function presentProjects(projects: readonly Project[]) {
  return projects.filter((project) => project.status === 'present');
}

function worktreeOptionLabel(worktree: Worktree) {
  if (worktree.branch) {
    return worktree.branch;
  }
  return `Detached at ${shortHead(worktree.head)}`;
}

function shortHead(head: string | null | undefined) {
  return head ? head.slice(0, 7) : 'unknown commit';
}

function isExistingWorktreePayload(value: unknown): value is ExistingWorktreePayload {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as ExistingWorktreePayload).kind === 'existing_worktree' &&
    typeof (value as ExistingWorktreePayload).projectId === 'number' &&
    typeof (value as ExistingWorktreePayload).worktreeId === 'number'
  );
}
