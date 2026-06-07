import { Effect } from 'effect';
import { GitBranch } from 'lucide-react';

import { openWorktreeFromPalette } from '../../workspace/queries.js';
import { listProjectBranches } from '../../workspace/runtime-data.js';
import { useWorkspaceStore } from '../../workspace/store.js';
import type { Project, Worktree } from '../../workspace/types.js';
import type { Option, PaletteCommand } from '../types.js';

interface ExistingWorktreePayload {
  readonly kind: 'existing_worktree';
  readonly projectId: number;
  readonly worktreeId: number;
}

interface ExistingBranchPayload {
  readonly kind: 'existing_branch';
  readonly branch: string;
  readonly projectId: number;
}

type WorktreeStepPayload = ExistingWorktreePayload | ExistingBranchPayload;

export const openWorktreeCommand: PaletteCommand = {
  id: 'open-worktree',
  label: 'Open Worktree',
  icon: GitBranch,
  group: 'global',
  available: (ctx) => presentProjects(ctx.projects).length > 0,
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
      emptyHint: 'Type a branch name or choose a worktree.',
      options: async (ctx, values): Promise<readonly Option<WorktreeStepPayload>[]> => {
        const projectId = Number(values.projectId);
        const project = presentProjects(ctx.projects).find(
          (candidate) => candidate.id === projectId,
        );
        if (!project) {
          return [];
        }

        const branchList = await Effect.runPromise(listProjectBranches(project.id));
        const worktreeOptions = [...project.worktrees].map((worktree) => ({
          value: worktree.branch ?? String(worktree.id),
          label: worktreeOptionLabel(worktree),
          hint: worktree.branch ? 'branch · already open' : 'commit · already open',
          payload: {
            kind: 'existing_worktree' as const,
            projectId: project.id,
            worktreeId: worktree.id,
          },
        }));
        const worktreeBranches = new Set(
          project.worktrees
            .map((worktree) => worktree.branch)
            .filter((branch): branch is string => Boolean(branch)),
        );
        const branchOptions = branchList.branches
          .filter((branch) => !worktreeBranches.has(branch.name))
          .map((branch) => ({
            value: branch.name,
            label: branch.name,
            hint: 'checkout branch',
            payload: {
              kind: 'existing_branch' as const,
              branch: branch.name,
              projectId: project.id,
            },
          }));

        return [...worktreeOptions, ...branchOptions].sort((left, right) =>
          left.label.localeCompare(right.label),
        );
      },
    },
  ],
  run: (values, ctx, payloads) => {
    const selected = payloads?.worktreeId;
    if (isExistingWorktreePayload(selected)) {
      useWorkspaceStore.getState().selectWorktree(selected.projectId, selected.worktreeId);
      return;
    }

    if (isExistingBranchPayload(selected)) {
      return openWorktreeFromPalette(selected.projectId, { branch: selected.branch }).then(
        () => undefined,
      );
    }

    const projectId = Number(values.projectId);
    const project = presentProjects(ctx.projects).find((candidate) => candidate.id === projectId);
    const worktree = project?.worktrees.find(
      (candidate) =>
        candidate.branch === values.worktreeId || String(candidate.id) === values.worktreeId,
    );
    if (project && worktree) {
      useWorkspaceStore.getState().selectWorktree(project.id, worktree.id);
      return;
    }

    if (project && values.worktreeId) {
      return openWorktreeFromPalette(project.id, { branch: values.worktreeId }).then(
        () => undefined,
      );
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

function isExistingBranchPayload(value: unknown): value is ExistingBranchPayload {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as ExistingBranchPayload).kind === 'existing_branch' &&
    typeof (value as ExistingBranchPayload).branch === 'string' &&
    typeof (value as ExistingBranchPayload).projectId === 'number'
  );
}
