import { editorActionCommands } from './editor-actions.js';
import { sessionActionCommands } from './session-actions.js';
import { surfaceActionCommands } from './surface-actions.js';
import { worktreeActionCommands } from './worktree-actions.js';

export const workbenchActionCommands = [
  ...surfaceActionCommands,
  ...worktreeActionCommands,
  ...sessionActionCommands,
  ...editorActionCommands,
] as const;
