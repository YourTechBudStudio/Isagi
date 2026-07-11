import type { DocsReconciliationAction, DocsReconciliationReason } from '@isagi/contracts';

// User-facing prose for the startup gate: the boot surface's status lines, the
// blocker states, and harness onboarding. Voice stays plain and dry; the light
// self-aware asides are allowed here because these are user-fixable startup edges,
// but every action label and diagnostic stays serious.
//
// The boot surface renders loading states as a single mono status line under the
// progress track — no titles or bodies — so those entries carry only `status` and
// the whisper `aside`. Blocker titles carry their own weight; the old eyebrows are
// gone.

type ExecutableAvailability = 'available' | 'missing' | 'incompatible' | 'probe_failed';

export const startupCopy = {
  connecting: {
    status: 'Reaching the runtime…',
    aside: '// gathering the facts before opening the door',
  },
  environmentPending: {
    status: 'Checking your environment…',
    aside: '// asking your shell, not guessing',
  },
  opening: {
    status: 'Opening your workspace…',
  },
  runtimeUnreachable: {
    title: 'Runtime unreachable.',
    body: 'Isagi could not reach its runtime to check your environment. Make sure the runtime is running, then try again.',
    retry: 'Try again',
    retrying: 'Reconnecting…',
  },
  configInvalid: {
    title: 'Your harness config is invalid.',
    body: "The harnesses section of Isagi's global config.yaml didn't parse. Fix it and restart Isagi — the runtime reads this once, at startup.",
    diagnosticLabel: 'config.yaml',
    quit: 'Quit Isagi',
  },
  toolchain: {
    title: 'Isagi needs an external toolchain.',
    body: 'Workflows are authored and verified with your own Node and package manager. Install what is missing, then check again.',
    nodeLabel: 'Node 22 or newer',
    environmentNote:
      'Isagi could not read your shell environment, so these results may be unreliable.',
    checkAgain: 'Check again',
    checking: 'Checking…',
    quit: 'Quit Isagi',
    aside: '// Isagi runs in your login shell; a fresh install shows up on the next check',
    availabilityLabel: {
      available: 'ready',
      missing: 'not found',
      incompatible: 'wrong version',
      probe_failed: "couldn't check",
    } satisfies Record<ExecutableAvailability, string>,
  },
} as const;

// Onboarding renders as "the boot manifest": mono config-file lines under the
// boot mark and track. Manifest-land strings (docs label, comments, stamps,
// notes) stay lowercase like the config they represent; titles, bodies, and
// buttons keep sentence case. Comment strings render behind a leading `#` added
// by the component. Onboarding is a humour-allowed surface, so the docs
// comments get one dry aside; buttons and results stay serious.
export const onboardingCopy = {
  title: 'Choose your coding agents.',
  body: 'Isagi launches agents through these harnesses. Turn on the ones you want — you can change this later.',
  detected: 'detected',
  notDetected: 'not detected',
  keyboardWhisper: '// ↑↓ move · space toggles · enter saves',
  docs: {
    label: 'install isagi-docs skill',
    comments: [
      'teaches your agents to configure isagi and author workflows.',
      "manual-only — it won't speak unless spoken to.",
    ],
  },
  save: 'Save and continue',
  saving: 'Setting things up…',
  emptyNote: 'no agents selected — you can open the workspace and turn some on later.',
  // Results are a failure-only surface: a fully successful save continues the
  // boot straight into the workspace, so there is no success title.
  results: {
    partialTitle: 'Setup finished with issues.',
    failedTitle: "Setup couldn't finish.",
    body: 'What happened for each agent:',
    continue: 'Open workspace',
    retry: 'Retry',
    retrying: 'Retrying…',
    superseded: 'your configuration changed while this was saving — showing the current result.',
  },
} as const;

// Per-harness Docs reconciliation outcome, keyed by the runtime's action and, for
// the non-success cases, its reason. Actions are manifest stamps (lowercase);
// reasons render as `#` comments under their line.
export const docsResultCopy = {
  action: {
    installed: 'installed',
    replaced: 'replaced',
    unchanged: 'up to date',
    untouched: 'not installed',
    failed: 'failed',
    unsupported: 'not supported',
  } satisfies Record<DocsReconciliationAction, string>,
  reason: {
    not_requested: 'docs were not requested for this agent.',
    environment_capture_failed: "isagi couldn't read your shell environment.",
    target_resolution_failed: "isagi couldn't resolve where this agent keeps skills.",
    explicit_invocation_unsupported: "this agent can't host a manual-only reference.",
    transaction_evidence: 'a previous install left files behind — remove them and retry.',
    publication_failed: "isagi couldn't write the docs files.",
    rollback_failed: 'a failed install could not be rolled back cleanly.',
  } satisfies Record<DocsReconciliationReason, string>,
} as const;
