export type WorktreeMenuCommandId =
  | 'start-terminal-session'
  | 'start-agent-session'
  | 'open-editor'
  | 'delete-active-worktree';

/** The ordered commands a worktree's rail menu offers under current capabilities. */
export function worktreeMenuCommandIds(input: {
  readonly editorAvailable: boolean;
  readonly isRoot: boolean;
}): WorktreeMenuCommandId[] {
  const commandIds: WorktreeMenuCommandId[] = ['start-terminal-session', 'start-agent-session'];
  if (input.editorAvailable) commandIds.push('open-editor');
  if (!input.isRoot) commandIds.push('delete-active-worktree');
  return commandIds;
}
