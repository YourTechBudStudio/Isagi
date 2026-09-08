import type { ControlPlaneSnapshot, WorkspaceSnapshot } from '@isagi/contracts';

/**
 * The seven workspaces this fixture can serve.
 *
 * These are real {@link WorkspaceSnapshot} values, not fixture-shaped lookalikes:
 * the page reads them through the production workspace query, so they have to
 * survive the same decode the app performs. Every name, path and branch is
 * invented; nothing here is loaded from a runtime and nothing here is real
 * workspace data.
 *
 * The set is chosen so that each scenario isolates one claim the folder
 * treatment makes, and so that the Git claims are testable against the *same*
 * chrome rather than against a remembered screenshot:
 *
 * - `present-folder`   — the base case: one folder project, one environment.
 * - `missing-folder`   — the recovery surface, and the only one with no worktrees.
 * - `git-branch`       — the Git control: a branch tag must still appear.
 * - `git-detached`     — a branchless Git worktree, which titles itself from its
 *                        basename and names its commit only in the status strip.
 * - `mixed`            — both kinds in one rail, which is where a treatment that
 *                        looks fine alone starts to look unfinished.
 * - `all-folder`       — a workspace with no Git at all: does the rail read as a
 *                        tool with a missing half?
 * - `missing-git`      — the Git recovery row, so `Set new path…` and `Check again`
 *                        can be compared as the alternatives they are.
 */
/**
 * What a folder project's single environment is called.
 *
 * Mirrors `FOLDER_ENVIRONMENT_TITLE` in
 * `apps/runtime/src/workspace/workspace.snapshot.ts`, which is where the real
 * value lives — the title arrives from the runtime, so this constant exists only
 * because the fixture builds its own snapshots and the web package does not
 * depend on the runtime package. It is no longer a stand-in for a value the
 * runtime disagreed with: phase 07 changed the runtime constant to match, so
 * these two now state the same product fact in the two places that need it.
 */
export const FOLDER_ENVIRONMENT_TITLE = 'folder';

export type ScenarioId =
  | 'present-folder'
  | 'missing-folder'
  | 'git-branch'
  | 'git-detached'
  | 'mixed'
  | 'all-folder'
  | 'two-missing'
  | 'missing-git';

export interface Scenario {
  readonly id: ScenarioId;
  readonly label: string;
  /** What this scenario is here to let someone judge. */
  readonly claim: string;
  readonly snapshot: WorkspaceSnapshot;
  /**
   * What the page opens on. `missingProject` selects the canvas recovery state;
   * `worktree` selects an environment.
   */
  readonly opens:
    | { readonly kind: 'worktree'; readonly projectId: number; readonly worktreeId: number }
    | { readonly kind: 'missingProject'; readonly projectId: number };
}

type SnapshotProject = WorkspaceSnapshot['projects'][number];
type SnapshotWorktree = SnapshotProject['worktrees'][number];

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'present-folder',
    label: 'Present folder',
    claim: 'One environment titled folder, subtitled with its path, no Git decoration.',
    snapshot: { projects: [notesFolder()] },
    opens: { kind: 'worktree', projectId: 40, worktreeId: 401 },
  },
  {
    id: 'missing-folder',
    label: 'Missing folder',
    claim: 'The recovery surface: Check again, and the three answers it can give.',
    snapshot: { projects: [missingNotesFolder(), isagiGit()] },
    opens: { kind: 'missingProject', projectId: 40 },
  },
  {
    id: 'git-branch',
    label: 'Git · branch',
    claim: 'The Git control. The branch is the title and the strip tag, never a third time.',
    snapshot: { projects: [isagiGit()] },
    opens: { kind: 'worktree', projectId: 10, worktreeId: 102 },
  },
  {
    id: 'git-detached',
    label: 'Git · detached',
    claim: 'A branchless Git worktree titles itself from its basename; the strip names the commit.',
    snapshot: { projects: [detachedGit()] },
    opens: { kind: 'worktree', projectId: 20, worktreeId: 202 },
  },
  {
    id: 'mixed',
    label: 'Mixed kinds',
    claim: 'Both kinds in one rail: every row is a name over a path, and nothing is said twice.',
    snapshot: { projects: [isagiGit(), notesFolder(), detachedGit(), scratchFolder()] },
    opens: { kind: 'worktree', projectId: 40, worktreeId: 401 },
  },
  {
    id: 'all-folder',
    label: 'All folders',
    claim: 'No Git at all. Identical environment titles, told apart by path and project header.',
    snapshot: { projects: [notesFolder(), scratchFolder(), designFolder()] },
    opens: { kind: 'worktree', projectId: 50, worktreeId: 501 },
  },
  {
    id: 'two-missing',
    label: 'Two missing',
    claim: 'Switching between missing projects: neither one inherits the other recovery state.',
    snapshot: { projects: [missingNotesFolder(), missingIsagiGit()] },
    opens: { kind: 'missingProject', projectId: 40 },
  },
  {
    id: 'missing-git',
    label: 'Missing Git',
    claim: 'The Git recovery row keeps Set new path…, which a folder never offers.',
    snapshot: { projects: [missingIsagiGit(), notesFolder()] },
    opens: { kind: 'missingProject', projectId: 10 },
  },
];

export const DEFAULT_SCENARIO: ScenarioId = 'mixed';

export function scenarioById(id: ScenarioId): Scenario {
  const found = SCENARIOS.find((scenario) => scenario.id === id);
  if (!found) throw new Error(`unknown scenario ${id}`);
  return found;
}

/**
 * The snapshot the runtime answers with once a missing folder is found again.
 * Restoration returns the *same* environment identity — same project id, same
 * worktree id, same path — which is the whole reason the recovery action never
 * has to touch selection.
 */
export function restoredSnapshot(
  snapshot: WorkspaceSnapshot,
  projectId: number,
): WorkspaceSnapshot {
  return {
    projects: snapshot.projects.map((project) => {
      if (project.id !== projectId || project.status !== 'missing') return project;
      return project.kind === 'folder'
        ? {
            id: project.id,
            name: project.name,
            rootPath: project.rootPath,
            kind: 'folder',
            status: 'present',
            worktrees: [folderEnvironment(project.id, project.rootPath)],
          }
        : {
            id: project.id,
            name: project.name,
            rootPath: project.rootPath,
            kind: 'git',
            status: 'present',
            worktrees: isagiGit().worktrees,
          };
    }),
  };
}

/** A settled control plane; the rail chrome reads editor provisioning from it. */
export const FIXTURE_CONTROL_PLANE: ControlPlaneSnapshot = {
  onboardingComplete: true,
  configStatus: 'valid',
  configDiagnostic: null,
  policyRevision: 'folder-project-fixture-policy',
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

function isagiGit(): SnapshotProject {
  return {
    id: 10,
    name: 'isagi',
    rootPath: '~/work/isagi',
    kind: 'git',
    status: 'present',
    worktrees: [
      gitWorktree(101, 10, '~/work/isagi', 'main', { isRoot: true, surfaces: ['shell'] }),
      gitWorktree(102, 10, '~/work/.isagi/wt/folder-projects', 'feat/folders', {
        surfaces: ['agent', 'pnpm check'],
      }),
      gitWorktree(103, 10, '~/work/.isagi/wt/linux-pkg', 'fix/linux-icons'),
    ],
  };
}

function missingIsagiGit(): SnapshotProject {
  return {
    id: 10,
    name: 'isagi',
    rootPath: '~/work/isagi',
    kind: 'git',
    status: 'missing',
    missingReason: 'The project directory is not on disk.',
    worktrees: [],
  };
}

function detachedGit(): SnapshotProject {
  return {
    id: 20,
    name: 'toph',
    rootPath: '~/work/toph',
    kind: 'git',
    status: 'present',
    worktrees: [
      gitWorktree(201, 20, '~/work/toph', 'main', { isRoot: true }),
      // No branch and a real head. Two things ride on this row: it is the one
      // shape that must still print `detached`, and — because a branchless
      // worktree falls back to its basename for a title — it is the only place
      // the short head appears in the rail at all.
      gitWorktree(202, 20, '~/work/.toph/wt/bisect', null, {
        head: '9f2c1ab4e7',
        surfaces: ['shell'],
      }),
    ],
  };
}

function notesFolder(): SnapshotProject {
  return folderProject(40, 'notes', '~/Documents/notes', ['agent']);
}

function scratchFolder(): SnapshotProject {
  return folderProject(50, 'scratch', '~/scratch', []);
}

function designFolder(): SnapshotProject {
  return folderProject(60, 'design-system-notes', '~/Documents/design-system-notes', ['shell']);
}

function missingNotesFolder(): SnapshotProject {
  return {
    id: 40,
    name: 'notes',
    rootPath: '~/Documents/notes',
    kind: 'folder',
    status: 'missing',
    // Phase 05's reconciliation writes presence, so the reason a folder project
    // carries is a directory fact rather than a Git one.
    missingReason: 'The project directory is not on disk.',
    worktrees: [],
  };
}

function folderProject(
  id: number,
  name: string,
  rootPath: string,
  surfaces: readonly string[],
): SnapshotProject {
  return {
    id,
    name,
    rootPath,
    kind: 'folder',
    status: 'present',
    // Exactly one, always. Phase 05 guarantees the cardinality; the UI's job is
    // to stop implying there could be others.
    worktrees: [folderEnvironment(id, rootPath, surfaces)],
  };
}

/**
 * A folder project's singleton environment, exactly as phase 05 projects it:
 * titled from {@link FOLDER_ENVIRONMENT_TITLE}, rooted at the project path,
 * `isRoot`, and carrying neither a branch nor a head — there is no Git to ask.
 */
function folderEnvironment(
  projectId: number,
  rootPath: string,
  surfaces: readonly string[] = ['agent'],
): SnapshotWorktree {
  return worktree(projectId * 10 + 1, projectId, FOLDER_ENVIRONMENT_TITLE, rootPath, {
    branch: null,
    head: null,
    isRoot: true,
    surfaces,
  });
}

/**
 * A Git worktree, titled the way the runtime titles one.
 *
 * `worktreeTitle` in `workspace.snapshot.ts` returns the branch when there is
 * one and the path's basename otherwise. Inventing friendlier titles here would
 * make the rail look better than it is and would hide the redundancy between a
 * row's title and its subtitle — which is a question this page exists to expose,
 * not to flatter.
 */
function gitWorktree(
  id: number,
  projectId: number,
  path: string,
  branch: string | null,
  options: {
    isRoot?: boolean;
    head?: string;
    surfaces?: readonly string[];
  } = {},
): SnapshotWorktree {
  return worktree(id, projectId, branch ?? basename(path), path, {
    branch,
    head: options.head ?? 'abc1234def',
    isRoot: options.isRoot ?? false,
    surfaces: options.surfaces ?? [],
  });
}

function worktree(
  id: number,
  projectId: number,
  title: string,
  path: string,
  options: {
    branch: string | null;
    head: string | null;
    isRoot: boolean;
    surfaces: readonly string[];
  },
): SnapshotWorktree {
  const surfaces = options.surfaces.map((surfaceTitle, index) => ({
    id: id * 10 + index + 1,
    title: surfaceTitle,
    paneKinds: ['terminal_session' as const],
  }));
  return {
    id,
    projectId,
    title,
    path,
    branch: options.branch,
    head: options.head,
    isRoot: options.isRoot,
    parked: false,
    surfaces,
    activeSurfaceId: surfaces[0]?.id ?? null,
  };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}
