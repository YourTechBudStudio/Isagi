import type {
  AgentSessionStatusReason,
  SessionStatus,
  TerminalSessionStatusReason,
} from '@isagi/contracts';

import type { MissingProject, Surface, Worktree } from '../lib/workspace/types.js';

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
  surfacePlaceholder: (surface: Surface) => {
    switch (surface.kind) {
      case 'browser':
        return '// a live browser surface \u2014 auto-detected from a running command';
      case 'editor':
        return '// VS Code in the browser \u2014 restores the artifacts you had open';
      default:
        return `// ${surface.title}`;
    }
  },
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
        case 'harness_session_id_missing':
          return 'No prior session';
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
      case 'harness_session_id_missing':
        return 'No harness session was captured for this pane, so a new one will start fresh.';
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
  agent: {
    loading: 'Loading agent surface...',
    loadFailed: (error: string) => `Could not load this agent surface. ${error}`,
  },
  terminal: {
    loading: 'Loading terminal...',
    loadFailed: (error: string) => `Could not load this terminal. ${error}`,
  },
} as const;
