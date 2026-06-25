export const workspaceQueryKey = ['workspace'] as const;
export const activeContextQueryKey = ['workspace', 'active-context'] as const;
export const surfaceDetailQueryKey = (surfaceId: number | null) => ['surface', surfaceId] as const;
export const worktreeCommandsQueryKey = (worktreeId: number | null) =>
  ['worktree', worktreeId, 'commands'] as const;
export const commandLogMetadataQueryKey = (worktreeId: number | null, commandName: string | null) =>
  ['worktree', worktreeId, 'commands', 'log-metadata', commandName] as const;
export const workflowDescriptorsQueryKey = (
  worktreeId: number | null,
  surfaceId: number | null,
  paneId: number | null,
  agentSessionId: number | null,
) => ['workflows', 'descriptors', { worktreeId, surfaceId, paneId, agentSessionId }] as const;
