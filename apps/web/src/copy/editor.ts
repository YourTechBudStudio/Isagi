import type {
  EditorAttemptFailureReason,
  EditorProcessDiagnostic,
  EditorProvisioningFailureReason,
} from '@isagi/contracts';

import type { EditorPaneView, EditorSettledReason } from '../lib/editor/view.js';

// User-facing prose for the embedded editor: Code Server provisioning at boot,
// and the editor pane from first launch through every settled failure.
//
// Every map here is keyed by a contract string union, so a new reason is a
// compile error rather than a blank surface. Two states are allowed a light
// touch — `idle` and `unknown`, both genuinely empty surfaces where nothing has
// gone wrong. Every actual failure is flat and factual, and says what was and
// was not done. Raw process output is never phrased; it is labelled evidence.

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * Boot-surface copy. `title`/`body` are sentence case because they render as a
 * blocker's heading and paragraph; `manifest` is the same fact in onboarding's
 * lowercase config-file voice, where it renders as a `#` comment beside the
 * harness lines.
 */
export const editorProvisioningCopy = {
  status: {
    checking: 'Checking for the editor…',
    downloading: 'Fetching the editor…',
    verifying: 'Verifying the download…',
    extracting: 'Unpacking the editor…',
  },
  failure: {
    title: {
      unsupported_platform: 'No editor build for this machine.',
      release_unavailable: "Couldn't reach the editor download.",
      download_failed: "The editor download didn't finish.",
      integrity_mismatch: "The download didn't match its checksum.",
      extract_failed: "Couldn't unpack the editor.",
      install_unusable: "The editor installed, but won't run.",
    } satisfies Record<EditorProvisioningFailureReason, string>,
    body: {
      unsupported_platform:
        "Isagi ships Code Server for macOS on Apple silicon and Intel, and for Linux x64. This machine isn't one of those, so there is nothing to retry.",
      release_unavailable:
        "The pinned Code Server release didn't come back. Usually the network; occasionally the other end.",
      download_failed:
        'The transfer broke partway through. Nothing was installed, so a retry starts clean.',
      integrity_mismatch:
        "What arrived isn't the release Isagi pinned, so it was thrown away rather than installed. A retry downloads it again.",
      extract_failed:
        "The archive arrived intact but wouldn't extract. Disk space and permissions on Isagi's tools directory are the usual causes.",
      install_unusable:
        "Unpacking finished and the Code Server binary still isn't where it should be, or won't execute.",
    } satisfies Record<EditorProvisioningFailureReason, string>,
    manifest: {
      unsupported_platform: 'no editor build for this machine.',
      release_unavailable: "couldn't reach the editor download.",
      download_failed: "the editor download didn't finish. nothing was installed.",
      integrity_mismatch: "the editor download didn't match its checksum. it was discarded.",
      extract_failed: "couldn't unpack the editor.",
      install_unusable: "the editor installed, but won't run.",
    } satisfies Record<EditorProvisioningFailureReason, string>,
  },
  /**
   * Only a failure the user can actually change the outcome of gets a retry. An
   * unsupported platform would fail identically forever, so it is stated and
   * left alone.
   */
  retryable: {
    unsupported_platform: false,
    release_unavailable: true,
    download_failed: true,
    integrity_mismatch: true,
    extract_failed: true,
    install_unusable: true,
  } satisfies Record<EditorProvisioningFailureReason, boolean>,
  retry: 'Try again',
  retrying: 'Trying again…',
  /** Onboarding's button row already holds a Save; this one has to name itself. */
  manifestRetry: 'Retry download',
  /**
   * The retry *request* failed — a dropped connection, or a runtime that refused
   * it. Distinct from the provisioning failure still on screen, which describes
   * the download rather than this attempt to restart it.
   */
  retryFailed: "The retry didn't go through.",
  /** The same fact in the manifest's lowercase config-file voice. */
  manifestRetryFailed: "the retry didn't go through.",
  diagnosticLabel: 'code-server',
} as const;

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

/**
 * Shared with `copy/errors.ts`, which builds `editor_launch_failed`'s reason map
 * from it: a launch failure has to read identically whether it arrives as an API
 * response or is read back from the durable projection.
 */
export const editorAttemptFailureCopy = {
  port_allocation_failed: "Couldn't reserve a local port for the editor.",
  session_socket_unavailable: "Couldn't create the editor's local socket.",
  launch_allocation_failed: "Couldn't start the editor process.",
  launch_interrupted: 'The launch was interrupted before the editor came up.',
  previous_incarnation_not_stopped:
    "The previous editor process wouldn't stop, so nothing was replaced.",
  launch_target_missing: "The worktree folder this editor points at isn't there any more.",
} satisfies Record<EditorAttemptFailureReason, string>;

export const editorProcessDiagnosticCopy = {
  launch_failed: 'Code Server failed to start.',
  attach_failed: "Isagi couldn't attach to the editor process.",
  process_missing: 'The editor process is gone.',
  exited: 'Code Server exited.',
  killed: 'The editor process was killed.',
} satisfies Record<EditorProcessDiagnostic, string>;

/** The header's right-hand status word. Lowercase, like every other pane's. */
export const editorPaneStatusCopy = {
  launching: 'starting',
  waiting_for_workbench: 'waiting',
  ready: 'ready',
  idle: 'idle',
  settled: 'stopped',
} satisfies Record<EditorPaneView['kind'], string>;

const editorProcessStatusCopy = {
  launch_failed: 'failed',
  attach_failed: 'failed',
  process_missing: 'gone',
  exited: 'exited',
  killed: 'killed',
} satisfies Record<EditorProcessDiagnostic, string>;

const editorSettledStatusCopy = {
  attempt_failed: 'failed',
  unreachable: 'unreachable',
  unknown: 'unknown',
} satisfies Record<Exclude<EditorSettledReason['kind'], 'process'>, string>;

/** A settled pane says what settled it, not just that something did. */
export function editorSettledStatusLabel(reason: EditorSettledReason): string {
  return reason.kind === 'process'
    ? editorProcessStatusCopy[reason.diagnostic]
    : editorSettledStatusCopy[reason.kind];
}

export function editorSettledCopy(reason: EditorSettledReason): string {
  switch (reason.kind) {
    case 'attempt_failed':
      return editorAttemptFailureCopy[reason.reason];
    case 'process':
      return editorProcessDiagnosticCopy[reason.diagnostic];
    case 'unreachable':
      return editorCopy.unreachable;
    case 'unknown':
      return editorCopy.unknown;
  }
}

export const editorCopy = {
  idle: 'No editor running for this worktree yet.',
  launching: 'Starting the editor…',
  waitingForWorkbench: 'Waiting for the workbench…',
  frameLoading: 'Loading the workbench…',
  unreachable: "The editor is running but isn't answering on its port.",
  // Nothing failed here — Isagi restarted and is being honest about what it can
  // no longer vouch for. No red, and the action is a start rather than a retry.
  unknown:
    "Isagi restarted and doesn't recognise the process it left here. Nothing is wrong — start it again.",
  action: {
    start: 'Start editor',
    restart: 'Restart editor',
    retry: 'Retry',
    starting: 'Starting…',
  },
  diagnostics: {
    show: 'Show startup output',
    hide: 'Hide startup output',
    /** Framing, not narration: what follows is Code Server's, never parsed by us. */
    label: (ptyProcessId: number) => `raw output · code-server · pid ${ptyProcessId}`,
    truncated: (droppedBytes: number) => `… ${formatBytes(droppedBytes)} dropped from the front`,
    empty: 'Isagi kept no startup output for this run.',
    retry: 'Try again',
  },
} as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  return kib < 1024 ? `${Math.round(kib)} KiB` : `${(kib / 1024).toFixed(1)} MiB`;
}
