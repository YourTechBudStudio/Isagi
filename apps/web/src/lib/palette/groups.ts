import type { PaletteGroup } from './types.js';

/** Display order of groups in search results. */
export const GROUP_ORDER: readonly PaletteGroup[] = [
  'global',
  'workflows',
  'worktree-commands',
  'worktree-actions',
  'worktree-surfaces',
  'switch-worktree',
];

export const GROUP_LABELS: Record<PaletteGroup, string> = {
  global: 'Global',
  workflows: 'Workflows',
  // `Commands` matches the drawer header and the product's own name for the
  // concept, so the row and the surface it opens agree on what they are called.
  'worktree-commands': 'Commands',
  'worktree-actions': 'This worktree',
  'worktree-surfaces': 'Surfaces',
  'switch-worktree': 'Switch worktree',
};
