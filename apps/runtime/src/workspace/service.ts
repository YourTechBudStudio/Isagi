import { Context, Effect, Layer } from 'effect';

import type {
  ActiveContextOutput,
  ActiveContextPersistenceInput,
  AddProjectOutput,
  DeleteProjectOutput,
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  DeleteWorktreePreflightOutput,
  DurableSessionInventory,
  ListProjectBranchesOutput,
  MoveProjectOrderOutput,
  MoveWorktreeOrderOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  ReconcileWorkspaceInput,
  ReconcileWorkspaceOutput,
  RelocateProjectOutput,
  WorkspaceSnapshot,
  WorktreeSetupPreflightOutput,
  WorktreeSetupResult,
  WorktreeSetupTrustInput,
  WorktreeSetupTrustOutput,
} from '@isagi/contracts';

import { CommandService } from '../commands/index.js';
import { AgentSessionService, SurfaceService } from '../environment/index.js';
import { InternalEvents } from '../platform/events/index.js';
import { Git, type GitCommandError } from '../platform/git/index.js';
import type { DatabaseError } from '../platform/persistence/index.js';
import { ProjectRepository } from '../projects/index.js';
import { PtyService } from '../pty-processes/index.js';
import { activeContext } from './active-context.js';
import { WorktreeDeleteDiagnosticsReader } from './delete-diagnostics.js';
import type {
  DetachedWorktree,
  DetachedWorktreeError,
  DetachedWorktreeInput,
} from './detached-worktree.js';
import type {
  MoveProjectOrderServiceError,
  MoveWorktreeOrderServiceError,
  WorkspaceServiceError,
} from './errors.js';
import type { NewDirectoryRejected } from './new-directory.js';
import { projectLifecycle } from './project-lifecycle.js';
import { reconciliation } from './reconcile.js';
import { WorktreeSetupRepository } from './setup/repository.js';
import { WorktreeSetupService } from './setup/service.js';
import { buildWorkspaceSnapshot } from './snapshot.js';
import type { StateFileError } from './state-file.js';
import { worktreeDelete } from './worktree-delete.js';
import { worktreeOpen } from './worktree-open.js';

/**
 * Project and worktree lifecycle orchestration. The methods live with the flow they belong to:
 *
 * - `project-lifecycle.ts`: register, relocate and delete projects, and the project and worktree order.
 * - `worktree-open.ts`: open a worktree, its setup trust and preflights, re-run setup, detached worktrees.
 * - `worktree-delete.ts`: delete a worktree and its preflight.
 * - `reconcile.ts`: reconcile rows against Git and the filesystem.
 * - `active-context.ts`: the active project and worktree in `state.json`.
 *
 * This file is the service's shape and its assembly, plus the two snapshot reads.
 */
const make = Effect.gen(function* () {
  const repository = yield* ProjectRepository;
  const surfaces = yield* SurfaceService;

  const get = Effect.gen(function* () {
    const projects = yield* repository.listProjects;
    const worktrees = yield* repository.listWorktrees;
    const surfaceMetadata = yield* surfaces.listWorkspaceSurfaceMetadata;
    const environmentFocus = yield* surfaces.listEnvironmentFocusStates;
    return buildWorkspaceSnapshot(projects, worktrees, surfaceMetadata, environmentFocus);
  }).pipe(Effect.withSpan('WorkspaceService.get'));

  const lifecycle = yield* projectLifecycle;
  const open = yield* worktreeOpen;
  const deletion = yield* worktreeDelete;
  const reconcile = yield* reconciliation;
  const context = yield* activeContext;

  return WorkspaceService.of({
    get,
    durableSessions: surfaces.listDurableSessions,
    publishRestoredActivation: context.publishRestoredActivation,
    getActiveContext: context.getActiveContext,
    setActiveContext: context.setActiveContext,
    registerProject: lifecycle.registerProject,
    relocateProject: lifecycle.relocateProject,
    deleteProject: lifecycle.deleteProject,
    moveProjectOrder: lifecycle.moveProjectOrder,
    moveWorktreeOrder: lifecycle.moveWorktreeOrder,
    reconcileWorkspace: reconcile.reconcileWorkspace,
    listProjectBranches: open.listProjectBranches,
    preflightWorktreeSetup: open.preflightWorktreeSetup,
    trustWorktreeSetup: open.trustWorktreeSetup,
    openWorktree: open.openWorktree,
    createDetachedWorktree: open.createDetachedWorktree,
    checkNewDirectory: open.checkNewDirectory,
    preflightWorktreeCreation: open.preflightWorktreeCreation,
    runWorktreeSetup: open.runWorktreeSetup,
    preflightDeleteWorktree: deletion.preflightDeleteWorktree,
    deleteWorktree: deletion.deleteWorktree,
  });
});

interface WorkspaceServiceShape {
  readonly get: Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>;
  /**
   * Startup: announces the persisted active worktree, if it still exists, as a
   * `worktree_activation_change` with cause `startup_restored`, so subscribers that act on the
   * active worktree (command lifecycle) converge on it before the first request. Run once, before
   * routes are registered.
   */
  readonly publishRestoredActivation: Effect.Effect<void, StateFileError | DatabaseError>;
  readonly durableSessions: Effect.Effect<DurableSessionInventory, WorkspaceServiceError>;
  readonly deleteProject: (
    projectId: number,
  ) => Effect.Effect<DeleteProjectOutput, WorkspaceServiceError>;
  readonly getActiveContext: Effect.Effect<ActiveContextOutput, WorkspaceServiceError>;
  readonly listProjectBranches: (input: {
    readonly projectId: number;
  }) => Effect.Effect<ListProjectBranchesOutput, WorkspaceServiceError>;
  readonly preflightWorktreeSetup: (input: {
    readonly projectId: number;
  }) => Effect.Effect<WorktreeSetupPreflightOutput, WorkspaceServiceError>;
  readonly trustWorktreeSetup: (input: {
    readonly projectId: number;
    readonly request: WorktreeSetupTrustInput;
  }) => Effect.Effect<WorktreeSetupTrustOutput, WorkspaceServiceError>;
  readonly openWorktree: (input: {
    readonly projectId: number;
    readonly request: OpenWorktreeInput;
  }) => Effect.Effect<OpenWorktreeOutput, WorkspaceServiceError>;
  /**
   * A worktree at an exact commit and an exact caller-chosen path, with no branch, no setup and no
   * post-create commands. A refused request writes nothing. See `detached-worktree.ts`.
   */
  readonly createDetachedWorktree: (
    input: DetachedWorktreeInput,
  ) => Effect.Effect<DetachedWorktree, DetachedWorktreeError | DatabaseError | GitCommandError>;
  /**
   * Read-only: whether `path` can become a new directory (absolute, absent or empty, outside every
   * checkout Isagi knows). Returns the canonical path. See `new-directory.ts`.
   */
  readonly checkNewDirectory: (
    path: string,
  ) => Effect.Effect<string, NewDirectoryRejected | DatabaseError>;
  /**
   * Whether this project could create this worktree right now, and the facts creating it would use:
   * the commit `fromRef` resolves to, and the checkout path Isagi would derive for the branch.
   *
   * Allocates nothing. It exists so an impossible creation request is refused before a caller
   * commits to it, and so the resolved commit is recorded rather than re-resolved later from a ref
   * that may have moved. It deliberately does not reconcile: the authoritative collision check is
   * the one `openWorktree` makes after its own `reconcileProject`.
   */
  readonly preflightWorktreeCreation: (input: {
    readonly projectId: number;
    readonly branch: string;
    readonly fromRef: string;
  }) => Effect.Effect<{ commit: string; checkoutPath: string }, WorkspaceServiceError>;
  /**
   * Re-runs post-create setup, and then the post-create command lifecycle, for a worktree that
   * already exists. Returns the same `setup` union `openWorktree` returns, minus `not_run`, which
   * only describes a worktree that was adopted rather than created.
   */
  readonly runWorktreeSetup: (input: {
    readonly projectId: number;
    readonly worktreeId: number;
  }) => Effect.Effect<Exclude<WorktreeSetupResult, { status: 'not_run' }>, WorkspaceServiceError>;
  readonly preflightDeleteWorktree: (input: {
    readonly projectId: number;
    readonly worktreeId: number;
  }) => Effect.Effect<DeleteWorktreePreflightOutput, WorkspaceServiceError>;
  readonly deleteWorktree: (input: {
    readonly projectId: number;
    readonly worktreeId: number;
    readonly request: DeleteWorktreeInput;
  }) => Effect.Effect<DeleteWorktreeOutput, WorkspaceServiceError>;
  readonly registerProject: (input: {
    readonly path: string;
  }) => Effect.Effect<AddProjectOutput, WorkspaceServiceError>;
  readonly relocateProject: (input: {
    readonly path: string;
    readonly projectId: number;
  }) => Effect.Effect<RelocateProjectOutput, WorkspaceServiceError>;
  readonly reconcileWorkspace: (
    input: ReconcileWorkspaceInput,
  ) => Effect.Effect<ReconcileWorkspaceOutput, WorkspaceServiceError>;
  readonly setActiveContext: (
    input: ActiveContextPersistenceInput,
  ) => Effect.Effect<ActiveContextOutput, WorkspaceServiceError>;
  readonly moveProjectOrder: (input: {
    readonly projectId: number;
    readonly beforeProjectId: number | null;
  }) => Effect.Effect<MoveProjectOrderOutput, MoveProjectOrderServiceError>;
  readonly moveWorktreeOrder: (input: {
    readonly projectId: number;
    readonly worktreeId: number;
    readonly beforeWorktreeId: number | null;
  }) => Effect.Effect<MoveWorktreeOrderOutput, MoveWorktreeOrderServiceError>;
}

export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()(
  'isagi/runtime/workspace/WorkspaceService',
) {
  static readonly layerNoDeps = Layer.effect(WorkspaceService, make);
  static readonly layer = WorkspaceService.layerNoDeps.pipe(
    Layer.provide([
      AgentSessionService.layer,
      CommandService.layer,
      Git.layer,
      InternalEvents.layer,
      ProjectRepository.layer,
      PtyService.layer,
      SurfaceService.layer,
      WorktreeDeleteDiagnosticsReader.layer,
      WorktreeSetupRepository.layer,
      WorktreeSetupService.layer,
    ]),
  );
}
