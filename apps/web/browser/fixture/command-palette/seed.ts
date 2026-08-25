import type {
  CommandLogMetadataLatestRun,
  CommandSummary,
  ControlPlaneSnapshot,
  SurfaceDetail,
  WorkspaceSnapshot,
} from '@isagi/contracts';

/**
 * The world the command-palette fixture's fake runtime serves.
 *
 * These are real contract shapes, not lookalikes: the page mounts the production
 * `CommandPalette` and `WorkbenchDrawer`, so everything here arrives through the
 * same decode the app uses.
 *
 * The shape is chosen for what the focus assertions need rather than for
 * plausible names. **Two** worktrees, each with one surface and one pane, so a
 * switch-worktree row has a real destination whose pane target is registered and
 * observable — without that, a "the drawer kept focus" assertion would pass
 * because nothing was ever going to take it. One missing project is present so
 * `relocate-project` is available and the Global group has its full three rows
 * for the four-group density state.
 *
 * All names, paths and branches are invented. Nothing here is real workspace
 * data and nothing here is loaded from a runtime.
 */

/** The worktree the fixture starts on, and the one a switch row navigates to. */
export const FIXTURE_ORIGIN = {
  projectId: 1,
  worktreeId: 12,
  surfaceId: 121,
  paneId: 1211,
} as const;
export const FIXTURE_DESTINATION = {
  projectId: 1,
  worktreeId: 13,
  surfaceId: 131,
  paneId: 1311,
} as const;

/** Both sides of the switch, seeded identically so neither can be the vacuous one. */
export const FIXTURE_PANES = [FIXTURE_ORIGIN, FIXTURE_DESTINATION] as const;

export const FIXTURE_SNAPSHOT: WorkspaceSnapshot = {
  projects: [
    {
      id: 1,
      name: 'isagi',
      rootPath: '/work/isagi',
      status: 'present',
      worktrees: [
        worktree(11, 'main', 'main', { isRoot: true }),
        worktree(12, 'commands in the palette', 'feat/palette-commands', {
          surface: [FIXTURE_ORIGIN.surfaceId, 'shell'],
        }),
        worktree(13, 'second worktree', 'feat/second', {
          surface: [FIXTURE_DESTINATION.surfaceId, 'shell'],
        }),
      ],
    },
    {
      id: 8,
      name: 'archive-2025',
      rootPath: '/work/archive-2025',
      status: 'missing',
      missingReason: 'The project directory is not on disk.',
      worktrees: [],
    },
  ],
};

export const FIXTURE_SURFACE_DETAILS: Readonly<Record<number, SurfaceDetail>> = {
  [FIXTURE_ORIGIN.surfaceId]: surfaceDetail(FIXTURE_ORIGIN),
  [FIXTURE_DESTINATION.surfaceId]: surfaceDetail(FIXTURE_DESTINATION),
};

/**
 * The catalog each worktree starts with. The origin carries one of every
 * presentation the phase-01 review approved — a startable row, a running row
 * with a port, an exited row, and a `failed` row that is still ordinary and
 * still startable — plus a fourth so the three-per-group cap is observable.
 */
/**
 * Resolved-port fixtures speak the replacement contract: source facts plus the
 * complete URL the runtime composed. A pathless entry carries an empty `urls`
 * list — it is a real resolved port with nothing to open.
 */
function fixturePort(port: number, urls: readonly (readonly [string, string])[] = []) {
  return {
    port,
    envVar: null,
    urls: urls.map(([label, path]) => ({ label, path, url: `http://localhost:${port}${path}` })),
  };
}

export const FIXTURE_CATALOG: Readonly<Record<number, readonly CommandSummary[]>> = {
  [FIXTURE_ORIGIN.worktreeId]: [
    { name: 'dev', status: 'idle', ports: [] },
    {
      name: 'api',
      status: 'running',
      ports: [fixturePort(8080, [['api', '/']]), fixturePort(9229)],
    },
    { name: 'typecheck', status: 'exited', ports: [] },
    { name: 'migrate', status: 'failed', ports: [] },
  ],
  [FIXTURE_DESTINATION.worktreeId]: [{ name: 'worker', status: 'idle', ports: [] }],
};

/**
 * The suspension review scenarios, applied by a test rather than served by
 * default — the catalog above is what the phase-01 palette assertions are
 * pinned to, and widening it would move counts those tests own.
 *
 * `dev` is the case a human is asked to judge first: a configured command that
 * was suspended by leaving the worktree and is still suspended after a runtime
 * restart, so nothing will start it without the user. `api` is degraded rather
 * than suspended — Isagi tried to stop it and could not — which is the one state
 * where a running command still owes the user an explanation.
 */
export const FIXTURE_SUSPENDED_COMMANDS: readonly CommandSummary[] = [
  { name: 'dev', status: 'suspended', ports: [] },
  { name: 'api', status: 'running', ports: [fixturePort(5173, [['app', '/']])] },
  { name: 'typecheck', status: 'failed', ports: [] },
];

/** A suspended command whose config entry vanished while it was suspended. */
export const FIXTURE_REMOVED_SUSPENDED: readonly CommandSummary[] = [
  { name: 'worker', status: 'suspended', ports: [] },
];

/** Live runtime state seen through a catalog that could not be parsed at all. */
export const FIXTURE_MANAGED_SUSPENDED: readonly CommandSummary[] = [
  { name: 'dev', status: 'suspended', ports: [] },
  { name: 'api', status: 'running', ports: [fixturePort(3000)] },
];

/**
 * The latest run behind `api` in the suspension scenarios: the stop attempt that
 * failed. The command is truthfully still `running`, and `process_control_failed`
 * is the reason the drawer has to voice — before this phase it had nowhere to
 * appear on a PTY-linked run at all.
 */
export const FIXTURE_CONTROL_FAILED_RUN: CommandLogMetadataLatestRun = {
  id: 41,
  startedAt: '2026-08-19T10:41:02.000Z',
  completedAt: null,
  status: 'running',
  ptyProcessId: 907,
  hasPtyProcess: true,
  diagnostic: {
    reason: 'process_control_failed',
    detail: 'Could not stop the process while leaving the worktree: kill ESRCH',
  },
};

/**
 * A settled control plane: inventory `ready` so the production query does not
 * start its one-second startup poll, and no harnesses, so the palette's
 * launchable-harness list is empty and the agent-session row stays inert.
 */
export const FIXTURE_CONTROL_PLANE: ControlPlaneSnapshot = {
  onboardingComplete: true,
  configStatus: 'valid',
  configDiagnostic: null,
  policyRevision: 'fixture-policy',
  inventory: { status: 'ready', generation: 1, environment: 'trusted' },
  harnesses: [],
  reconciliation: {
    desiredFingerprint: null,
    runningFingerprint: null,
    lastCompletedFingerprint: null,
    lastAppliedFingerprint: null,
    lastResult: null,
  },
};

function worktree(
  id: number,
  title: string,
  branch: string,
  options: { isRoot?: boolean; surface?: readonly [number, string] } = {},
): WorkspaceSnapshot['projects'][number]['worktrees'][number] {
  const surfaces = options.surface
    ? [
        {
          id: options.surface[0],
          title: options.surface[1],
          paneKinds: ['terminal_session' as const],
        },
      ]
    : [];
  return {
    id,
    projectId: 1,
    title,
    path: `/work/.isagi/wt/${id}`,
    branch,
    head: 'abc1234',
    isRoot: options.isRoot ?? false,
    parked: false,
    surfaces,
    activeSurfaceId: surfaces[0]?.id ?? null,
  };
}

function surfaceDetail(place: {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId: number;
}): SurfaceDetail {
  return {
    id: place.surfaceId,
    worktreeId: place.worktreeId,
    title: 'shell',
    layout: {
      kind: 'leaf',
      nodeId: `leaf-${place.paneId}`,
      paneId: place.paneId,
      collapsed: false,
    },
    activePaneId: place.paneId,
    // A pane with no session still forms a workflow launch context, which is what
    // keeps the Workflows group a real (and by default empty) production query
    // rather than a broken one.
    panes: [
      { id: place.paneId, surfaceId: place.surfaceId, title: 'shell', sortOrder: 0, session: null },
    ],
  };
}
