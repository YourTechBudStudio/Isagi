import type { PaletteGroup } from './types.js';

/** Display order of groups in search results. */
export const GROUP_ORDER: readonly PaletteGroup[] = [
  'global',
  'worktree-actions',
  'worktree-surfaces',
  'switch-worktree',
];

export const GROUP_LABELS: Record<PaletteGroup, string> = {
  global: 'Global',
  'worktree-actions': 'This worktree',
  'worktree-surfaces': 'Surfaces',
  'switch-worktree': 'Switch worktree',
};
