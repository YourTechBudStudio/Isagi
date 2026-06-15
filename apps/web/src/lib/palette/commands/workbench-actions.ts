import { sessionActionCommands } from './session-actions.js';
import { surfaceActionCommands } from './surface-actions.js';
import { worktreeActionCommands } from './worktree-actions.js';

export const workbenchActionCommands = [
  ...surfaceActionCommands,
  ...worktreeActionCommands,
  ...sessionActionCommands,
] as const;
