export const paletteCopy = {
  placeholders: {
    choose: 'choose\u2026',
    chooseOrTypeName: 'choose or type a name\u2026',
    command: 'Type a command\u2026',
    projectRootPath: 'Type a repository root path\u2026',
    repositoryRootPath: 'Type the repository root path\u2026',
    typedValue: 'type a value\u2026',
  },
  emptySearch: 'No matches. Maybe try a different query?',
  textStep: {
    useValue: 'Press enter to use:',
    typeThenUse: 'Type a value, then press enter.',
  },
  pathStep: {
    addPath: 'Press enter to add this path:',
    typeRepositoryRoot: 'Type a repository root path.',
    goDeeper: '/ to go deeper',
  },
  reviewStep: {
    loadingSetupHooks: 'Reading setup hooks...',
  },
  wizardStep: {
    loading: 'Loading\u2026',
  },
  tips: {
    cycle: 'cycle',
    fill: 'fill',
    fillOrAdd: 'fill/add',
    back: 'back',
    select: 'select',
    move: 'move',
    run: 'run',
    close: 'close',
    anywhere: (modKey: string) => `tip: ${modKey}K from anywhere`,
  },
} as const;

export const worktreeSetupReviewCopy = {
  title: "This project has setup hooks Isagi hasn't run yet.",
  body: "They're defined in .isagi/config.yaml and run right after the worktree is created. Worth a look before you let them touch your machine.",
  choices: {
    trustHookConfig: {
      label: 'Trust these hooks',
      hint: 'Isagi runs them now, and asks again only if they change.',
    },
    alwaysTrustProject: {
      label: 'Always trust this project',
      hint: 'Isagi runs these and any future changes, no more prompts.',
    },
    disableHooks: {
      label: 'Skip hooks for this project',
      hint: 'Isagi keeps creating worktrees, just never runs the hooks.',
    },
  },
} as const;
