import type { WorkspaceData } from '../model.js';
import type { Project, Surface, Worktree } from '../types.js';

export function surface(input: { readonly id: number; readonly title?: string }): Surface {
  return {
    id: input.id,
    title: input.title ?? `surface-${input.id}`,
    paneKinds: [],
    attention: 'idle',
  };
}

export function worktree(input: {
  readonly id: number;
  readonly projectId: number;
  readonly title?: string;
  readonly isRoot?: boolean;
  readonly surfaces?: readonly Surface[];
}): Worktree {
  const title = input.title ?? (input.isRoot ? 'main' : `worktree-${input.id}`);
  return {
    id: input.id,
    projectId: input.projectId,
    title,
    path: `/repo/${input.projectId}/${title}`,
    branch: title,
    head: 'abcdef0',
    isRoot: input.isRoot ?? false,
    attention: 'idle',
    parked: false,
    surfaces: input.surfaces ?? [],
    activeSurfaceId: null,
  };
}

export function project(input: {
  readonly id: number;
  readonly name: string;
  readonly surfaces?: readonly Surface[];
  /** Replaces the default single root worktree outright. */
  readonly worktrees?: readonly Worktree[];
  readonly status?: 'present' | 'missing';
}): Project {
  const base = {
    id: input.id,
    name: input.name,
    rootPath: `/repo/${input.name}`,
    glyph: input.name.slice(0, 2).toUpperCase(),
    accent: 'blue' as const,
    worktrees: input.worktrees ?? [
      worktree({
        id: input.id * 10,
        projectId: input.id,
        isRoot: true,
        surfaces: input.surfaces ?? [],
      }),
    ],
  };
  return input.status === 'missing'
    ? { ...base, status: 'missing', missingReason: 'path_not_found' }
    : { ...base, status: 'present' };
}

export function workspace(projects: readonly Project[]): WorkspaceData {
  return { projects };
}
