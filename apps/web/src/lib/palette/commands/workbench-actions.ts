import { surfaceActionCommands } from './surface-actions.js';
import { worktreeActionCommands } from './worktree-actions.js';

export const workbenchActionCommands = [
  ...surfaceActionCommands,
  ...worktreeActionCommands,
] as const;
