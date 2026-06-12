export const worktreeSetupFailureCopy = {
  title: 'Worktree created, setup failed.',
  body: {
    createdPrefix: 'Isagi created',
    hookFailedPrefix: 'but hook',
    hookFailedMiddle: 'failed while running',
  },
  meta: {
    setupRunLabel: 'setup run',
    worktreeLabel: 'worktree',
  },
  actions: {
    copyError: 'Copy error',
    openAnyway: 'Open worktree anyway',
  },
} as const;
