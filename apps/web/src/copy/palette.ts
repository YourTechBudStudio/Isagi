import { workbenchCopy } from './workbench.js';

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
    },
    // Error-detail rows: a broken winning package (per key), or a whole-list
    // discovery failure (source scan vs. generic). Row labels/subtitles are
    // concise state; the reason-specific explanation and framed diagnostic live
    // in the outcome panel. Absolute paths and request ids stay in `diagnostic`.
    failure: {
      diagnosticLabel: 'Diagnostic',
      broken: {
        sub: "Couldn't load. Select for details.",
        title: "Couldn't load this workflow.",
      },
      discovery: {
        label: "Workflows couldn't be scanned.",
        sub: 'Select for details.',
        title: "Workflows couldn't be scanned.",
        body: "Isagi couldn't read one of the workflow source paths.",
      },
      generic: {
        label: "Couldn't load workflows.",
        sub: 'Select for details.',
        title: "Couldn't load workflows.",
        body: "Isagi couldn't load the workflow list.",
      },
    },
    startFailed: {
      title: 'Workflow did not start.',
      diagnosticLabel: 'Runtime detail',
    },
  },
  // The Commands section: rows are configured worktree processes. Subs state
  // the selection behavior in plain working chrome \u2014 startable rows launch, the
  // running row only opens details (it must never read like a restart). A
  // command whose last run failed is still a startable row, because starting a
  // fresh run is exactly what selecting it does; the drawer owns run history.
  // Failure-row labels reuse the drawer panel titles verbatim: the row opens
  // exactly that panel, so the sentence must be the same sentence.
  commands: {
    sub: {
      run: 'run command',
      // A suspended command already exists and is waiting to continue, so the
      // row says what selecting it does to *that* command rather than offering a
      // generic launch.
      resume: 'Resume',
      running: (ports: readonly number[]) =>
        ports.length === 0
          ? 'open details'
          : `open details \u00b7 ${ports.map((port) => `:${port}`).join(' ')}`,
    },
    failure: {
      configError: {
        label: workbenchCopy.commandConfigDiagnosticTitle,
        sub: 'Select for details.',
      },
      unavailable: {
        label: workbenchCopy.commandReadFailedTitle,
        sub: 'Select for details.',
      },
    },
  },
  wizardStep: {
    loading: 'Loading\u2026',
  },
  flow: {
    continue: 'Continue',
    multiSelectHint: 'Space to select, Enter to continue.',
    requiredField: 'Answer this before continuing.',
    requiredConfirm: 'Confirm this before continuing.',
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
  // Calm status while a command's async run is in flight. The chip names the
  // surface, the title is the generic fallback for commands without their own
  // running copy, and the tip is a dry one-liner — no performed cuteness.
  running: {
    chip: 'Working',
    title: 'Working…',
    tip: 'This can take a moment.',
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

/** Copy for surface and pane actions. Menu and button labels are plain working chrome. */
export const surfaceActionsCopy = {
  menu: {
    rename: 'Rename surface',
    delete: 'Delete surface',
  },
  chooseHarness: 'Choose a harness before splitting this pane.',
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
const openEditorLabel = 'Open editor';

export const worktreeActionsCopy = {
  startTerminal: startTerminalLabel,
  startAgentSession: startAgentSessionLabel,
  openEditor: openEditorLabel,
  /** The palette row's second line: what "editor" actually means here. */
  openEditorHint: 'open in code-server',
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

/**
 * Shown in the palette's running state while a brand-new worktree is being
 * created. Creation blocks on server-side setup hooks (copy/symlink/command),
 * so the status names that work rather than leaving the palette looking stuck.
 */
export const worktreeCreateCopy = {
  running: {
    title: 'Creating worktree…',
    hint: 'Running setup hooks.',
  },
  // Shown in the palette when the worktree was created but a setup hook failed.
  // The checkout exists and is already open, so this is a partial-success result
  // (warning tone), not a hard failure — name the hook and show the raw output.
  setupFailed: {
    title: 'Worktree created — a setup hook failed.',
    body: (hookIndex: number, hookType: string) =>
      `Hook ${hookIndex} (${hookType}) didn’t finish. The checkout is ready and open; only setup fell short.`,
    diagnosticLabel: 'Setup output',
  },
} as const;
