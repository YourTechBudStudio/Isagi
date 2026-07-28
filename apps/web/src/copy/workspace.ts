import type {
  AgentSessionStatusReason,
  SessionStatus,
  TerminalSessionStatusReason,
} from '@isagi/contracts';

import type { MissingProject, Worktree } from '../lib/workspace/types.js';

export const workspaceBootCopy = {
  restoring: {
    title: 'Restoring the workspace.',
    body: 'Isagi is asking the runtime for projects, worktrees, and the last room you had open.',
    aside: '// no empty-state snap; wait for the facts',
  },
  runtimeConnectionFailed: {
    title: 'Runtime connection failed.',
    body: 'Isagi could not load the workspace snapshot. Check the runtime process and try again.',
  },
} as const;

export const workAreaCopy = {
  runtimeRefreshFailed: (error: string) => `runtime refresh failed \u00b7 ${error}`,
  zenExitHint: 'exit \u00b7 esc',
} as const;

export const canvasCopy = {
  freshEmpty: {
    title: 'No worktrees on the canvas.',
    body: "Point Isagi at a repo root. It'll find the worktrees you forgot you made.",
    aside: '// git already knows; Isagi remembers where you were',
  },
  noSurface: {
    title: 'No surfaces here yet.',
    body: (worktree: Worktree) =>
      `Isagi found ${worktree.title}. Agents, terminals, commands, and restored surfaces land in the next slices.`,
    aside: '// navigation first; room furniture later',
  },
} as const;

export const missingProjectCopy = {
  eyebrow: 'Project unavailable',
  title: "Can't use this project right now.",
  bodyPrefix: 'Isagi expected',
  bodySuffix: (project: MissingProject) => `but it isn't there anymore. ${project.missingReason}`,
  aside: '// it was here a minute ago',
  confirm: {
    title: 'Remove this project?',
    body: 'Isagi forgets it. Files on disk are left alone.',
  },
} as const;

export const ptyCopy = {
  emptySurface: 'Nothing running here yet. cmd+k to start something.',
  noSession: 'No session',
  attaching: 'Attaching',
  emptyPane: "This pane's empty \u2014 nothing's claimed it yet.",
  /**
   * The cold-reconstruction cover. Working chrome the user sees on every cold
   * revisit, so it stays dry status copy \u2014 no humour, no reassurance, no
   * progress claim Isagi cannot actually make.
   */
  reconstructing: 'Loading history\u2026',
  movedAttachment: {
    status: 'Moved',
    title: 'This session moved elsewhere.',
    body: 'Start fresh in this pane, or claim the session back here.',
    action: {
      startFresh: 'Start fresh',
      claim: 'Claim session',
    },
  },
  unsupportedHarness: {
    status: 'Unsupported',
    title: 'Harness not wired yet.',
    body: "This adapter isn't connected to Isagi's runtime yet. The pane is real; the harness is still a TODO with shoes on.",
    action: 'Delete pane',
  },
  renderer: {
    webglFallback: 'WebGL renderer fell back to canvas.',
    webglUnavailable: 'WebGL renderer unavailable; using canvas.',
  },
  /**
   * The terminal that was supposed to show a session never got built. This
   * happens before the claim, so it promises only what is always true — nothing
   * was replaced or discarded — and never that a process is running: the same
   * failure can land while resuming a stopped session, where none is. The
   * honest recovery is "try again", not "start fresh", which would throw a
   * durable session away over a renderer failure. No humour: nothing about a
   * pane that will not open is funny to the person waiting on it.
   */
  presentationFailed: {
    status: 'Terminal failed',
    title: "Couldn't build this terminal.",
    body: "Nothing happened to the session — Isagi just couldn't put a terminal in front of it.",
    action: 'Try again',
  },
  /**
   * A terminal that was being rebuilt from replay when the stream ended, or
   * whose replay outgrew what the reveal could hold. The buffer holds part of a
   * session, so it is never shown: a half-restored terminal reads as a real one
   * and would be trusted like a real one. Same shape and same recovery as a
   * build failure — try again, never "start fresh" — and, likewise, no humour.
   */
  restoreIncomplete: {
    status: 'Restore incomplete',
    title: "This terminal didn't finish restoring.",
    body: "The stream ended before the session was whole. Isagi is showing nothing rather than part of a session you'd have no reason to trust.",
    action: 'Try again',
  },
  sealed: {
    exited: 'Process exited. Final output is retained.',
    moved: 'Attachment moved. Final output is retained.',
    disconnected: 'Connection ended. Final output is retained.',
    errored: 'Connection failed. Final output is retained.',
    superseded: 'Attachment was replaced. Final output is retained.',
    reconnect: 'Reconnect',
    startFresh: 'Start fresh',
  },
  sessionStatus: (
    status: SessionStatus | null,
    statusReason: AgentSessionStatusReason | TerminalSessionStatusReason | null,
    exit: { readonly exitCode: number | null; readonly signal: string | null },
  ) => {
    if (statusReason) {
      switch (statusReason) {
        case 'runtime_shutdown':
          return 'Killed on shutdown';
        case 'harness_launch_failed':
        case 'shell_launch_failed':
          return 'Launch failed';
        case 'harness_process_exited':
        case 'shell_exited':
          return 'Exited';
        case 'harness_process_killed':
        case 'shell_killed':
          return 'Killed';
        case 'process_attach_failed':
          return 'Attach failed';
        case 'harness_metadata_missing':
          return 'Session record missing';
        case 'harness_metadata_invalid':
          return 'Session record invalid';
        case 'harness_resume_failed':
          return 'Resume failed';
        case 'pty_process_missing':
          return 'Process missing';
        case 'pty_process_not_running':
          return 'Process not running';
      }
    }

    switch (status) {
      case 'starting':
        return 'Starting';
      case 'running':
        return 'Running';
      case 'exited':
        return exit.exitCode === null ? 'Exited' : `Exited with code ${exit.exitCode}`;
      case 'failed':
        if (exit.exitCode !== null) {
          return `Failed with code ${exit.exitCode}`;
        }
        if (exit.signal) {
          return `Stopped by ${exit.signal}`;
        }
        return 'Failed to start';
      case 'killed':
        return 'Killed';
      default:
        return 'Unknown';
    }
  },
  sessionNotice: (
    _status: SessionStatus | null,
    statusReason: AgentSessionStatusReason | TerminalSessionStatusReason | null,
  ): string | null => {
    switch (statusReason) {
      case 'runtime_shutdown':
        return 'The runtime shut down and stopped this session.';
      case 'harness_launch_failed':
      case 'shell_launch_failed':
        return "The session did not launch. Check the output above, then delete the pane when you're done.";
      case 'harness_process_exited':
      case 'shell_exited':
        return null;
      case 'harness_process_killed':
      case 'shell_killed':
        return null;
      case 'process_attach_failed':
        return 'Isagi could not attach to this session. The pane keeps the evidence it still has.';
      case 'harness_metadata_missing':
        return 'The harness session record is missing, so this pane needs a replacement.';
      case 'harness_metadata_invalid':
        return 'The harness session record is unreadable, so this pane needs a replacement.';
      case 'harness_resume_failed':
        return 'Could not resume the harness session.';
      case 'pty_process_missing':
        return 'Isagi could not find the backing process for this session.';
      case 'pty_process_not_running':
        return 'The backing process is not running.';
      case null:
        return null;
    }
  },
} as const;

export const surfaceDetailCopy = {
  loading: 'Loading surface...',
  loadFailed: (error: string) => `Could not load this surface. ${error}`,
} as const;
