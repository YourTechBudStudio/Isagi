import type { ControlPlaneSnapshot, WorkspaceSnapshot } from '@isagi/contracts';

/**
 * The workspace the fixture's fake runtime serves.
 *
 * This is a real {@link WorkspaceSnapshot}, not a fixture-shaped lookalike: the
 * page mounts the production `Rail`, so the data has to arrive through the same
 * decode the app uses. The shape is chosen for *height and nesting* rather than
 * for plausible names — one tall project whose active worktree is expanded to
 * four surfaces, a second present project with its own non-root worktrees, a
 * third short one to prove a project can be dropped at either end, and a
 * Disconnected section to hover illegally.
 *
 * All names, paths and branches are invented. Nothing here is real workspace
 * data and nothing here is loaded from a runtime.
 */
export const FIXTURE_SNAPSHOT: WorkspaceSnapshot = {
  projects: [
    {
      id: 1,
      name: 'isagi',
      rootPath: '/work/isagi',
      status: 'present',
      worktrees: [
        worktree(11, 1, 'main', '/work/isagi', 'main', { isRoot: true, surfaces: [['shell']] }),
        worktree(12, 1, 'rail drag reordering', '/work/.isagi/wt/rail-drag', 'feat/rail-drag', {
          surfaces: [['plan review'], ['fixture'], ['pnpm check'], ['scratch']],
        }),
        worktree(13, 1, 'update footer polish', '/work/.isagi/wt/update-footer', 'fix/footer', {
          surfaces: [['agent']],
        }),
        worktree(14, 1, 'linux packaging', '/work/.isagi/wt/linux-pkg', 'fix/linux-icons', {
          parked: true,
        }),
        worktree(15, 1, 'harness ledger', '/work/.isagi/wt/harness-ledger', 'feat/ledger', {
          surfaces: [['agent']],
        }),
      ],
    },
    {
      id: 2,
      name: 'toph',
      rootPath: '/work/toph',
      status: 'present',
      worktrees: [
        worktree(21, 2, 'main', '/work/toph', 'main', { isRoot: true }),
        worktree(22, 2, 'streaming rewrite', '/work/.toph/wt/streaming', 'feat/streaming'),
        worktree(23, 2, 'docs pass', '/work/.toph/wt/docs', 'chore/docs'),
      ],
    },
    {
      id: 3,
      name: 'sketchbook',
      rootPath: '/work/sketchbook',
      status: 'present',
      worktrees: [worktree(31, 3, 'main', '/work/sketchbook', 'main', { isRoot: true })],
    },
    {
      id: 8,
      name: 'archive-2025',
      rootPath: '/work/archive-2025',
      status: 'missing',
      missingReason: 'The project directory is not on disk.',
      worktrees: [],
    },
    {
      id: 9,
      name: 'old-runtime',
      rootPath: '/work/old-runtime',
      status: 'missing',
      missingReason: 'The project directory is not on disk.',
      worktrees: [],
    },
  ],
};

/**
 * A settled control plane whose editor provisioning is `ready`, which is the one
 * fact `editorAvailable` reads. Inventory is `ready` too, so the production query
 * never starts its one-second startup poll behind the rail.
 */
export const FIXTURE_CONTROL_PLANE: ControlPlaneSnapshot = {
  onboardingComplete: true,
  configStatus: 'valid',
  configDiagnostic: null,
  policyRevision: 'rail-fixture-policy',
  inventory: { status: 'ready', generation: 1, environment: 'trusted' },
  harnesses: [],
  reconciliation: {
    desiredFingerprint: null,
    runningFingerprint: null,
    lastCompletedFingerprint: null,
    lastAppliedFingerprint: null,
    lastResult: null,
  },
  editorProvisioning: { status: 'ready', version: '1.0.0' },
};

/** The worktree the fixture opens expanded — the only one showing a surface list. */
export const FIXTURE_ACTIVE = { projectId: 1, worktreeId: 12 } as const;

function worktree(
  id: number,
  projectId: number,
  title: string,
  path: string,
  branch: string,
  options: {
    isRoot?: boolean;
    parked?: boolean;
    /** Surface titles, in display order. Ids are derived as `<worktreeId><n>`. */
    surfaces?: readonly (readonly [string])[];
  } = {},
): WorkspaceSnapshot['projects'][number]['worktrees'][number] {
  const surfaces = (options.surfaces ?? []).map(([surfaceTitle], index) => ({
    id: id * 10 + index + 1,
    title: surfaceTitle,
    paneKinds: ['terminal_session' as const],
  }));
  return {
    id,
    projectId,
    title,
    path,
    branch,
    head: 'abc1234',
    isRoot: options.isRoot ?? false,
    parked: options.parked ?? false,
    surfaces,
    activeSurfaceId: surfaces[0]?.id ?? null,
  };
}
