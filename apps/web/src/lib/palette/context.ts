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
): PaletteContext {
  const activeWorktree =
    projects
      .flatMap((project) => project.worktrees)
      .find((worktree) => worktree.id === activeWorktreeId) ?? null;
  return {
    projects,
    activeWorktree,
    activeProject: findWorktreeProject(projects, activeWorktree),
  };
}
