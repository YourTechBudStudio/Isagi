export const workspaceQueryKey = ['workspace'] as const;
export const activeContextQueryKey = ['workspace', 'active-context'] as const;
export const surfaceDetailQueryKey = (surfaceId: number) => ['surface', surfaceId] as const;
export const worktreeCommandsQueryKey = (worktreeId: number | null) =>
  ['worktree', worktreeId, 'commands'] as const;
