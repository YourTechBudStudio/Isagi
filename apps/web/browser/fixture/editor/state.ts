import type {
  AgentHarness,
  ControlPlaneSnapshot,
  EditorContextFacts,
  EditorProvisioningState,
  HarnessLaunchProjection,
} from '@isagi/contracts';

import type { EditorDiagnosticsState } from '../../../src/routes/workspace/EditorPane.js';

/**
 * Contract-shaped fixtures for the editor surfaces. Every pane state is authored
 * as the facts the runtime would actually project, so the gallery exercises the
 * real `editorPaneView` reduction rather than a hand-written answer to it.
 *
 * This module and its gallery live outside the production bundle by construction
 * — a separate Vite root — and `browser/specs/production-bundle.spec.ts` proves
 * it. Phase 08 deletes the directory once the pane reads live data.
 */
export const EDITOR_FIXTURE_MARKER = 'data-editor-fixture';

/** The stand-in workbench: a real document, so the frame's load cover is real. */
export const WORKBENCH_URL = './workbench.html';

/**
 * One surface identity for the whole contact sheet, so every card can register a
 * real focus target with the shared router and the gallery can ask the router to
 * land focus on one of them — the same delivery path the palette and the drawer
 * use when they close.
 */
export const FIXTURE_WORKTREE_ID = 3;
export const FIXTURE_SURFACE_ID = 41;
export const fixturePaneId = (index: number) => 100 + index;

const BASE: EditorContextFacts = {
  id: 7,
  worktreeId: 3,
  activePtyProcessId: null,
  attempt: { state: 'none' },
  processStatus: null,
  processDiagnostic: null,
  processDiagnosticDetail: null,
  workbenchReadiness: null,
  readinessDetail: null,
  endpoint: null,
  hasDiagnostics: false,
  createdAt: '2026-08-31T09:00:00.000Z',
  updatedAt: '2026-08-31T09:12:00.000Z',
};

const LIVE = {
  activePtyProcessId: 48120,
  processStatus: 'running',
  endpoint: { host: '127.0.0.1', port: 41287, url: WORKBENCH_URL },
} as const;

const facts = (overrides: Partial<EditorContextFacts>): EditorContextFacts => ({
  ...BASE,
  ...overrides,
});

const LOG_EXCERPT = `[2026-08-31T09:12:04.881Z] info  Using user-data-dir ~/.isagi/tools/code-server-data
[2026-08-31T09:12:05.104Z] info  Using config file ~/.isagi/tools/code-server-data/config.yaml
[2026-08-31T09:12:05.219Z] error Error: listen EADDRINUSE: address already in use 127.0.0.1:41287
    at Server.setupListenHandle [as _listen2] (node:net:1898:16)
    at listenInCluster (node:net:1955:12)`;

export interface EditorPaneFixture {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly context: EditorContextFacts;
  readonly notice: string | null;
  /** What an opened disclosure resolves to for this incarnation. */
  readonly diagnostics: OpenDiagnostics;
  /**
   * Wire the shared pane chrome — cluster, context menu, pending-delete locking —
   * against local state. Only one fixture takes it: the chrome is the same on
   * every pane, and putting it on all of them would bury the state under it.
   */
  readonly chrome?: boolean;
}

type OpenDiagnostics = Exclude<EditorDiagnosticsState, { kind: 'closed' }>;

const loaded = (truncated: boolean): OpenDiagnostics => ({
  kind: 'loaded',
  output: {
    editorContextId: 7,
    ptyProcessId: 48120,
    excerpt: LOG_EXCERPT,
    truncated,
    totalBytes: truncated ? 16384 + LOG_EXCERPT.length : LOG_EXCERPT.length,
  },
});

export const PANE_FIXTURES: readonly EditorPaneFixture[] = [
  {
    id: 'idle',
    label: 'idle',
    note: 'attempt none, no pointer. Start dispatches reuse.',
    context: facts({}),
    notice: null,
    diagnostics: loaded(false),
  },
  {
    id: 'launching',
    label: 'launching',
    note: 'attempt in_progress. No action while it runs.',
    context: facts({ attempt: { state: 'in_progress', startedAt: '2026-08-31T09:12:00.000Z' } }),
    notice: null,
    diagnostics: loaded(false),
  },
  {
    id: 'waiting',
    label: 'waiting_for_workbench',
    note: 'process live, readiness probe running.',
    context: facts({ ...LIVE, workbenchReadiness: 'pending' }),
    notice: null,
    diagnostics: loaded(false),
  },
  {
    id: 'ready',
    label: 'ready',
    note: 'the frame loads for real — watch the cover hand over, then the header recede.',
    context: facts({ ...LIVE, workbenchReadiness: 'ready' }),
    notice: null,
    diagnostics: loaded(false),
  },
  {
    id: 'attempt-failed',
    label: 'settled · attempt_failed',
    note: 'nothing survived the attempt. Rule 1.',
    context: facts({
      attempt: {
        state: 'failed',
        reason: 'port_allocation_failed',
        detail: 'no free port in 41000-41999',
      },
    }),
    notice: null,
    diagnostics: loaded(false),
  },
  {
    id: 'refused-replacement',
    label: 'refused replacement',
    note: 'a failed attempt AND a surviving process. The banner sits over the live state.',
    context: facts({
      ...LIVE,
      workbenchReadiness: 'pending',
      attempt: { state: 'failed', reason: 'previous_incarnation_not_stopped', detail: null },
    }),
    notice: null,
    diagnostics: loaded(false),
  },
  {
    id: 'exited',
    label: 'settled · process(exited)',
    note: 'disclosure closed by default.',
    context: facts({
      activePtyProcessId: 48120,
      processStatus: 'exited',
      processDiagnostic: 'exited',
      processDiagnosticDetail: 'code 1',
      hasDiagnostics: true,
    }),
    notice: null,
    diagnostics: loaded(true),
  },
  {
    id: 'killed',
    label: 'settled · process(killed)',
    note: 'the OOM killer, or someone with a terminal.',
    context: facts({
      activePtyProcessId: 48120,
      processStatus: 'killed',
      processDiagnostic: 'killed',
      processDiagnosticDetail: 'SIGKILL',
      hasDiagnostics: true,
    }),
    notice: null,
    diagnostics: loaded(false),
  },
  {
    id: 'launch-failed',
    label: 'settled · process(launch_failed)',
    note: 'never got off the ground.',
    context: facts({
      activePtyProcessId: 48120,
      processStatus: 'failed',
      processDiagnostic: 'launch_failed',
      processDiagnosticDetail: 'spawn ENOENT',
      hasDiagnostics: true,
    }),
    notice: null,
    diagnostics: loaded(false),
  },
  {
    id: 'no-diagnostics',
    label: 'settled · nothing retained',
    note: 'hasDiagnostics false — no disclosure is offered at all.',
    context: facts({
      activePtyProcessId: 48120,
      processStatus: 'failed',
      processDiagnostic: 'attach_failed',
      processDiagnosticDetail: null,
      hasDiagnostics: false,
    }),
    notice: null,
    diagnostics: loaded(false),
  },
  {
    id: 'unreachable',
    label: 'settled · unreachable',
    note: 'alive, not listening. The probe gave up.',
    context: facts({
      ...LIVE,
      workbenchReadiness: 'unreachable',
      readinessDetail: '127.0.0.1:41287 · ECONNREFUSED',
      hasDiagnostics: true,
    }),
    notice: null,
    diagnostics: loaded(false),
  },
  {
    id: 'unknown',
    label: 'settled · unknown',
    note: 'no red, and the action starts rather than retries — nothing failed.',
    context: facts({ ...LIVE, workbenchReadiness: 'unknown' }),
    notice: null,
    diagnostics: loaded(false),
  },
  {
    id: 'diagnostics-loading',
    label: 'diagnostics · loading',
    note: 'open the disclosure: a sweep, never a spinner.',
    context: facts({
      activePtyProcessId: 48120,
      processStatus: 'exited',
      processDiagnostic: 'exited',
      processDiagnosticDetail: 'code 1',
      hasDiagnostics: true,
    }),
    notice: null,
    diagnostics: { kind: 'loading' },
  },
  {
    id: 'diagnostics-failed',
    label: 'diagnostics · unavailable',
    note: 'the read failed. It says nothing about the editor, so the retry is local to it.',
    context: facts({
      activePtyProcessId: 48120,
      processStatus: 'exited',
      processDiagnostic: 'exited',
      processDiagnosticDetail: 'code 1',
      hasDiagnostics: true,
    }),
    notice: null,
    diagnostics: {
      kind: 'failed',
      detail:
        "Couldn't read the editor's startup output. editor_diagnostics_unavailable · request 8f21",
    },
  },
  {
    id: 'chrome',
    label: 'pane chrome · split, delete, origins',
    note: 'the cluster (hover) and the header menu (right-click). Delete carries where it started; the sweep lands there and nowhere else.',
    context: facts({}),
    notice: null,
    chrome: true,
    diagnostics: loaded(false),
  },
  {
    id: 'idle-notice',
    label: 'idle + request error',
    note: 'a mount-time reuse failed while the projection still reads idle.',
    context: facts({}),
    notice: "Couldn't reach the runtime. Is it still running?",
    diagnostics: loaded(false),
  },
  {
    id: 'ready-notice',
    label: 'ready + request error',
    note: 'a failed replace must not hide a working editor — and it pins the header open.',
    context: facts({ ...LIVE, workbenchReadiness: 'ready' }),
    notice: "The editor isn't installed yet. editor_rejected · request 4c07",
    diagnostics: loaded(false),
  },
];

export interface ProvisioningFixture {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly state: EditorProvisioningState;
  readonly retrying: boolean;
}

const VERSION = '4.135.0';

export const PROVISIONING_FIXTURES: readonly ProvisioningFixture[] = [
  {
    id: 'checking',
    label: 'checking',
    note: 'receipt lookup. Usually gone in a blink.',
    state: { status: 'checking', version: VERSION },
    retrying: false,
  },
  {
    id: 'downloading',
    label: 'downloading',
    note: 'the long one. Phase name only — the track carries "still moving".',
    state: { status: 'downloading', version: VERSION },
    retrying: false,
  },
  {
    id: 'verifying',
    label: 'verifying',
    note: 'SHA-256 over ~200 MB.',
    state: { status: 'verifying', version: VERSION },
    retrying: false,
  },
  {
    id: 'extracting',
    label: 'extracting',
    note: 'system tar.',
    state: { status: 'extracting', version: VERSION },
    retrying: false,
  },
  {
    id: 'failed-download',
    label: 'failed · download_failed',
    note: 'the common one.',
    state: {
      status: 'failed',
      version: VERSION,
      reason: 'download_failed',
      diagnostic: 'socket hang up after 84.2 MB',
    },
    retrying: false,
  },
  {
    id: 'failed-retrying',
    label: 'failed · retrying',
    note: 'the track returns to running and live; the diagnostic stays until it resolves.',
    state: {
      status: 'failed',
      version: VERSION,
      reason: 'download_failed',
      diagnostic: 'socket hang up after 84.2 MB',
    },
    retrying: true,
  },
  {
    id: 'failed-integrity',
    label: 'failed · integrity_mismatch',
    note: 'sharpened: it says the download was discarded, not merely wrong.',
    state: {
      status: 'failed',
      version: VERSION,
      reason: 'integrity_mismatch',
      diagnostic: 'expected 9f2c…a41d, got 3b70…ee92',
    },
    retrying: false,
  },
  {
    id: 'failed-platform',
    label: 'failed · unsupported_platform',
    note: 'no retry at all — it would fail identically forever.',
    state: {
      status: 'failed',
      version: VERSION,
      reason: 'unsupported_platform',
      diagnostic: 'freebsd-arm64',
    },
    retrying: false,
  },
  {
    id: 'failed-release',
    label: 'failed · release_unavailable',
    note: 'usually the network; occasionally the other end.',
    state: { status: 'failed', version: VERSION, reason: 'release_unavailable', diagnostic: null },
    retrying: false,
  },
  {
    id: 'failed-extract',
    label: 'failed · extract_failed',
    note: 'arrived intact, would not unpack.',
    state: {
      status: 'failed',
      version: VERSION,
      reason: 'extract_failed',
      diagnostic: 'tar: Cannot write: No space left on device',
    },
    retrying: false,
  },
  {
    id: 'failed-unusable',
    label: 'failed · install_unusable',
    note: 'unpacked, and still not runnable.',
    state: {
      status: 'failed',
      version: VERSION,
      reason: 'install_unusable',
      diagnostic: 'bin/code-server: permission denied',
    },
    retrying: false,
  },
];

/** Both fall straight through the gate; neither reaches the boot surface. */
export const FALLTHROUGH_STATES: readonly EditorProvisioningState[] = [
  { status: 'ready', version: VERSION },
  { status: 'not_applicable' },
];

/**
 * Onboarding's own composition, so a provisioning failure is reviewed where it
 * actually lands: a `#` comment among the harness lines and a button in the
 * existing row, at the real 340px manifest width — not as a string in a table.
 */
function harnessEntry(harness: AgentHarness, launch: HarnessLaunchProjection) {
  return {
    harness,
    availability: 'available' as const,
    policy: { enabled: launch.status === 'launchable', installIsagiDocs: false },
    launch,
  };
}

export const ONBOARDING_SNAPSHOT: ControlPlaneSnapshot = {
  onboardingComplete: false,
  configStatus: 'valid',
  configDiagnostic: null,
  policyRevision: 'rev-1',
  inventory: { status: 'ready', generation: 1, environment: 'trusted' },
  harnesses: [
    harnessEntry('codex', { status: 'launchable' }),
    harnessEntry('claude', { status: 'launchable' }),
    harnessEntry('pi', { status: 'blocked', reason: 'harness_missing' }),
    harnessEntry('opencode', { status: 'blocked', reason: 'harness_missing' }),
  ],
  reconciliation: {
    desiredFingerprint: null,
    runningFingerprint: null,
    lastCompletedFingerprint: null,
    lastAppliedFingerprint: null,
    lastResult: null,
  },
  editorProvisioning: { status: 'not_applicable' },
};

/** The provisioning states onboarding has anything at all to say about. */
export const ONBOARDING_FAILURE_FIXTURES: readonly ProvisioningFixture[] =
  PROVISIONING_FIXTURES.filter((fixture) => fixture.state.status === 'failed');
