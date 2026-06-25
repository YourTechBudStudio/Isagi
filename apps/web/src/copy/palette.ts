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
    searching: 'Searching…',
    goDeeper: '/ to go deeper',
  },
  reviewStep: {
    loading: 'Reading setup hooks...',
  },
  workflows: {
    start: 'Start workflow',
    disabled: {
      occupied: 'Dismiss the current workflow first.',
      broken: 'Manifest did not load.',
    },
    startFailed: {
      title: 'Workflow did not start.',
      diagnosticLabel: 'Runtime detail',
    },
  },
  wizardStep: {
    loading: 'Loading\u2026',
  },
  outcome: {
    resultLabel: 'Result',
    errorLabel: 'Could not run command',
    localFeedback: 'Review what happened.',
    commandUnavailableTitle: 'Command is no longer available.',
    commandUnavailableBody:
      'The workspace changed while the palette was open. Close this and try again.',
    close: 'Close',
    diagnostic: 'Diagnostic detail',
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

/**
 * Copy for the rename/delete surface + pane actions. Menu and button labels are
 * plain working chrome. The destructive confirmations lean on the danger styling
 * to carry weight, so the words stay flat and factual. Process cleanup is owned
 * by runtime GC, so confirmation copy does not promise an immediate stop.
 */
export const surfaceActionsCopy = {
  menu: {
    rename: 'Rename surface',
    delete: 'Delete surface…',
  },
  deletePane: {
    title: 'Delete this pane?',
    body: 'This session is still running. Isagi will delete the pane; cleanup runs in the background.',
    confirm: 'Delete pane',
    cancel: 'Cancel',
  },
  deleteSurface: {
    title: 'Delete this surface?',
    confirm: 'Delete surface',
    cancel: 'Cancel',
    /**
     * Shown only when at least one of the surface's sessions is live. Leads with
     * the running count (the real stake), then reassures what survives. Handles
     * the single-pane, all-live, and some-live shapes grammatically.
     */
    body: (paneCount: number, liveCount: number): string => {
      const panes = paneCount === 1 ? '1 pane' : `${paneCount} panes`;
      const sessions = liveCount === 1 ? '1 session is' : `${liveCount} sessions are`;
      return `This will delete ${panes}. ${sessions} still running; cleanup runs in the background.`;
    },
  },
  renameSurface: {
    placeholder: 'Type a surface title…',
    emptyTitle: 'Surface title cannot be empty.',
    titleTooLong: 'Surface title must be 80 characters or fewer.',
  },
} as const;

// Canonical session-action labels, shared by the command palette command
// definitions and the rail worktree context menu so the two never drift. The
// menu appends an ellipsis where the action opens a follow-on step (harness
// pick, delete confirm); the immediate terminal action carries none.
const startTerminalLabel = 'Start terminal';
const startAgentSessionLabel = 'Start agent session';

export const worktreeActionsCopy = {
  startTerminal: startTerminalLabel,
  startAgentSession: startAgentSessionLabel,
  menu: {
    startTerminal: startTerminalLabel,
    startAgent: `${startAgentSessionLabel}…`,
    delete: 'Delete worktree…',
  },
  deleteWorktree: {
    dirtyReview: {
      title: 'Worktree has uncommitted or untracked changes.',
      body: 'Deleting this checkout removes the checkout and those changes.',
      checkoutLabel: 'Checkout',
      confirm: 'Delete checkout',
      cancel: 'Cancel',
    },
    mode: {
      checkoutOnly: {
        label: 'Delete checkout only',
        hint: 'Keeps the Git branch.',
      },
      checkoutAndBranch: {
        label: 'Delete checkout and branch',
        hint: 'Uses safe branch deletion.',
      },
    },
    rootNotDeletable: {
      title: 'Root worktree cannot be deleted.',
      body: 'The main checkout stays as the project fallback.',
    },
    branchDeleteFailed: {
      title: 'Checkout deleted. Branch was not deleted.',
      body: 'Git refused to delete the branch safely. The checkout is already gone.',
      diagnosticLabel: 'Git output',
    },
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
