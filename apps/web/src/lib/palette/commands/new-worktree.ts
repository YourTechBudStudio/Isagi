import { SquarePlus } from 'lucide-react';

import { useWorkspaceStore } from '../../workspace/store.js';
import type { Option, PaletteCommand } from '../types.js';

function uniqueBranches(branches: readonly string[]): string[] {
  return [...new Set(branches)];
}

/**
 * The flagship multi-arg global command: project → worktree → harness, every
 * step pre-defaulted so the common path is enter-enter-enter. Defaults are
 * worktree-optimized (current project + current worktree) via the context.
 */
export const newWorktreeCommand: PaletteCommand = {
  id: 'new-worktree',
  label: 'New worktree',
  icon: SquarePlus,
  group: 'global',
  args: [
    {
      kind: 'select',
      key: 'project',
      label: 'Project',
      options: (ctx): Option[] => [
        ...ctx.projects.map((project) => ({
          value: project.id,
          label: project.name,
          isDefault: project.id === ctx.activeProject?.id,
        })),
        { value: '__new', label: 'New project…', create: true },
      ],
    },
    {
      kind: 'combo',
      key: 'worktree',
      label: 'Worktree / branch',
      prefix: 'wt/',
      options: (ctx, values): Option[] => {
        const project = ctx.projects.find((candidate) => candidate.id === values.project);
        const branches = uniqueBranches(
          project?.worktrees.map((worktree) => worktree.branch) ?? [],
        );
        const current = ctx.activeWorktree?.branch;
        const sameProject = project?.id === ctx.activeProject?.id;
        if (branches.length === 0) {
          return [{ value: 'main', isDefault: true }];
        }
        return branches.map((branch) => {
          const isDefault = sameProject && branch === current;
          if (branch === current) {
            return { value: branch, isDefault, hint: 'current' };
          }
          return { value: branch, isDefault, hint: 'existing' };
        });
      },
    },
    {
      kind: 'select',
      key: 'harness',
      label: 'Agent harness',
      options: (): Option[] => [
        { value: 'skip', label: 'No agent', isDefault: true },
        { value: 'pi', label: 'Pi' },
        { value: 'claude', label: 'Claude Code' },
        { value: 'codex', label: 'Codex' },
        { value: 'opencode', label: 'OpenCode' },
      ],
    },
  ],
  run: (values) => {
    useWorkspaceStore
      .getState()
      .createWorktree(values.project ?? '', values.worktree ?? '', values.harness ?? 'skip');
  },
};
