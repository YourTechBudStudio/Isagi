import { GitBranch } from 'lucide-react';

import type { WorktreeBaseRef, WorktreeSetupTrustInput } from '@isagi/contracts';

import { worktreeCreateCopy, worktreeSetupReviewCopy } from '../../../copy/index.js';
import { runRuntimeEffect } from '../../runtime/run.js';
import { restoreActivePaneFocus } from '../../workspace/activation.js';
import { openWorktreeFromPalette } from '../../workspace/queries.js';
import {
  listProjectBranches,
  preflightWorktreeSetup,
  trustWorktreeSetup,
} from '../../workspace/runtime-data.js';
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

interface BaseRefPayload {
  readonly kind: 'base_ref';
  readonly base: WorktreeBaseRef;
}

interface SetupReviewPayload {
  readonly kind: 'setup_review';
  readonly trust?: WorktreeSetupTrustInput | undefined;
}

type WorktreeStepPayload = ExistingWorktreePayload | ExistingBranchPayload;

export const openWorktreeCommand: PaletteCommand = {
  id: 'open-worktree',
  label: 'Open worktree',
  icon: GitBranch,
  group: 'global',
  running: worktreeCreateCopy.running,
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
      kind: 'combo',
      key: 'branch',
      label: 'Worktree',
      defaultSelection: 'none',
      emptyHint: 'Type a branch name, or choose a worktree.',
      createHint: 'create branch',
      finishOnAccept: (_value, payload) => isExistingWorktreePayload(payload),
      options: async (ctx, values): Promise<readonly Option<WorktreeStepPayload>[]> => {
        const projectId = Number(values.projectId);
        const project = presentProjects(ctx.projects).find(
          (candidate) => candidate.id === projectId,
        );
        if (!project) {
          return [];
        }

        const branchList = await runRuntimeEffect(listProjectBranches(project.id));
        const worktreeOptions = [...project.worktrees].map((worktree) => ({
          value: worktree.branch ?? String(worktree.id),
          label: worktreeOptionLabel(worktree),
          hint: 'open',
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
            hint: 'new worktree',
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
    {
      kind: 'select',
      key: 'base',
      label: 'Create from',
      // An existing branch (or worktree) needs no base — skip straight to
      // creation. Only a brand-new branch has a "create from" choice.
      skip: (_ctx, _values, payloads) => isExistingBranchPayload(payloads.branch),
      options: async (ctx, values): Promise<readonly Option<BaseRefPayload>[]> => {
        const projectId = Number(values.projectId);
        const project = presentProjects(ctx.projects).find(
          (candidate) => candidate.id === projectId,
        );
        if (!project) {
          return [];
        }

        const branchList = await runRuntimeEffect(listProjectBranches(project.id));
        const branchOptions = branchList.branches.map((branch) => ({
          value: `branch:${branch.name}`,
          label: branch.name,
          isDefault:
            ctx.activeProject?.id === project.id && branch.name === ctx.activeWorktree?.branch,
          payload: {
            kind: 'base_ref' as const,
            base: { kind: 'branch' as const, ref: branch.name },
          },
        }));

        const activeWorktree = ctx.activeProject?.id === project.id ? ctx.activeWorktree : null;
        const activeDetachedCommit =
          activeWorktree && !activeWorktree.branch && activeWorktree.head
            ? activeWorktree.head
            : null;
        const commitOption =
          activeDetachedCommit && activeWorktree
            ? [
                {
                  value: `detached-worktree:${activeWorktree.id}`,
                  label: `Current detached commit ${shortHead(activeDetachedCommit)}`,
                  isDefault: true,
                  payload: {
                    kind: 'base_ref' as const,
                    base: {
                      kind: 'detached_worktree' as const,
                      worktreeId: activeWorktree.id,
                    },
                  },
                },
              ]
            : [];

        return [...commitOption, ...branchOptions].sort((left, right) =>
          left.label.localeCompare(right.label),
        );
      },
    },
    {
      kind: 'review',
      key: 'setupTrust',
      label: 'Setup hooks',
      load: async (_ctx, values) => {
        const projectId = Number(values.projectId);
        const preflight = await runRuntimeEffect(preflightWorktreeSetup(projectId));
        if (preflight.status === 'needs_approval' && preflight.hash) {
          return {
            title: worktreeSetupReviewCopy.title,
            body: worktreeSetupReviewCopy.body,
            items: preflight.summary,
            choices: [
              {
                value: 'trust-hook-config',
                label: worktreeSetupReviewCopy.choices.trustHookConfig.label,
                hint: worktreeSetupReviewCopy.choices.trustHookConfig.hint,
                payload: {
                  kind: 'setup_review' as const,
                  trust: { action: 'trust_hook_config' as const, hash: preflight.hash },
                },
              },
              {
                value: 'always-trust-project',
                label: worktreeSetupReviewCopy.choices.alwaysTrustProject.label,
                hint: worktreeSetupReviewCopy.choices.alwaysTrustProject.hint,
                payload: {
                  kind: 'setup_review' as const,
                  trust: { action: 'always_trust_project' as const, hash: preflight.hash },
                },
              },
              {
                value: 'disable-hooks',
                label: worktreeSetupReviewCopy.choices.disableHooks.label,
                hint: worktreeSetupReviewCopy.choices.disableHooks.hint,
                payload: {
                  kind: 'setup_review' as const,
                  trust: { action: 'disable_hooks' as const },
                },
              },
            ],
          };
        }
        // No approval decision to make (no hooks, or already trusted/disabled):
        // skip the review screen entirely and create the worktree directly.
        return null;
      },
    },
  ],
  run: async (values, ctx, payloads) => {
    const selected = payloads?.branch;
    if (isExistingWorktreePayload(selected)) {
      useWorkspaceStore.getState().selectWorktree(selected.projectId, selected.worktreeId);
      restoreActivePaneFocus();
      return;
    }

    const projectId = Number(values.projectId);
    const project = presentProjects(ctx.projects).find((candidate) => candidate.id === projectId);
    const worktree = project?.worktrees.find(
      (candidate) => candidate.branch === values.branch || String(candidate.id) === values.branch,
    );
    if (project && worktree) {
      useWorkspaceStore.getState().selectWorktree(project.id, worktree.id);
      restoreActivePaneFocus();
      return;
    }

    if (!project || !values.branch) {
      return;
    }

    const review = payloads?.setupTrust;
    if (isSetupReviewPayload(review) && review.trust) {
      await runRuntimeEffect(trustWorktreeSetup(project.id, review.trust));
    }

    const base = payloads?.base;
    if (isBaseRefPayload(base)) {
      await openWorktreeFromPalette(project.id, { branch: values.branch, base: base.base });
      return;
    }

    await openWorktreeFromPalette(project.id, { branch: values.branch });
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

function isExistingBranchPayload(value: unknown): value is ExistingBranchPayload {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as ExistingBranchPayload).kind === 'existing_branch'
  );
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

function isSetupReviewPayload(value: unknown): value is SetupReviewPayload {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as SetupReviewPayload).kind === 'setup_review'
  );
}

function isBaseRefPayload(value: unknown): value is BaseRefPayload {
  if (!value || typeof value !== 'object' || (value as BaseRefPayload).kind !== 'base_ref') {
    return false;
  }

  const base = (value as BaseRefPayload).base;
  if (!base || typeof base !== 'object') {
    return false;
  }

  return (
    (base.kind === 'branch' && typeof base.ref === 'string') ||
    (base.kind === 'detached_worktree' && typeof base.worktreeId === 'number')
  );
}
