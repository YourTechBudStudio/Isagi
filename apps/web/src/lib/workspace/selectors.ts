import type { ProjectKind } from '@isagi/contracts';

import type { Surface, Worktree } from './types.js';

/**
 * A worktree row's second line: the environment's path, and nothing else.
 *
 * The Git ref used to be appended here for every worktree, and is gone for both
 * kinds. It was never carrying its own weight: the runtime's `worktreeTitle`
 * returns `worktree.branch` whenever there is one, so a branched worktree
 * printed its branch twice — once as the row's title, again after the path. A
 * folder environment has no ref at all, so the fallback produced the literal
 * word `detached`, which is not merely unhelpful but false; nothing is detached
 * because nothing was ever attached.
 *
 * The ref is not lost. {@link branchLabel} still names the *active* environment's
 * branch or short head in the status strip, which is the one place it is
 * load-bearing rather than repeated. The narrow cost is a branchless Git
 * worktree that is not currently selected: it titles itself from its basename,
 * so its commit is not on screen until it is.
 */
export function worktreeSubtitle(worktree: Worktree): string {
  return compactHomePath(worktree.path);
}

/**
 * The status strip's ref tag, or `null` when there is no ref to name.
 *
 * A folder project has no branch and no head, so it gets no tag rather than a
 * fabricated one. Callers must resolve the project kind before asking: passing a
 * guessed `'git'` for an unknown project would put `detached` back on a folder
 * environment through the one path that still formats refs.
 */
export function branchLabel(worktree: Worktree, projectKind: ProjectKind): string | null {
  return projectKind === 'folder' ? null : gitRef(worktree);
}

export function findActiveSurface(worktree: Worktree): Surface | null {
  return worktree.surfaces.find((surface) => surface.id === worktree.activeSurfaceId) ?? null;
}

export function compactHomePath(path: string): string {
  return path;
}

function gitRef(worktree: Worktree) {
  return worktree.branch ?? shortHead(worktree.head) ?? 'detached';
}

function shortHead(head: string | null | undefined) {
  return head ? head.slice(0, 7) : null;
}
