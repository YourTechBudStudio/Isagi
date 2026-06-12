import type { PtySessionStatus } from '@isagi/contracts';

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
  emptyPane: "This pane's empty \u2014 nothing's claimed it yet.",
  renderer: {
    webglFallback: 'WebGL renderer fell back to canvas.',
    webglUnavailable: 'WebGL renderer unavailable; using canvas.',
  },
  sessionStatus: (
    status: PtySessionStatus | null,
    exit: { readonly exitCode: number | null; readonly signal: string | null },
  ) => {
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
      default:
        return 'Unknown';
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
