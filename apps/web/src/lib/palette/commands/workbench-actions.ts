import { editorActionCommands } from './editor-actions.js';
import { projectActionCommands } from './project-actions.js';
import { sessionActionCommands } from './session-actions.js';
import { surfaceActionCommands } from './surface-actions.js';
import { worktreeActionCommands } from './worktree-actions.js';

export const workbenchActionCommands = [
  ...surfaceActionCommands,
  ...projectActionCommands,
  ...worktreeActionCommands,
  ...sessionActionCommands,
  ...editorActionCommands,
] as const;
