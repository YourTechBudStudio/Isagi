import { Effect } from 'effect';

import type { DatabaseError } from '../../../persistence/index.js';
import { SurfaceError, validateSurfaceTitle } from '../../../surfaces/index.js';
import {
  WorkspaceError,
  type WorkspaceServiceError,
} from '../../../workspace/workspace.service.js';
import type { WorkflowRunRecord } from '../../persistence/records.js';
import type { WorkflowRunsRepositoryService } from '../../persistence/runs.repository.js';
import { WorkflowEngineError, type WorkflowOrigin } from '../../types.js';
import type { LaunchProject, PlacementSelection, ResolvedPlacement } from './types.js';
/**
 * What the worktree preflight can still fail with once its own rejections have been mapped.
 *
 * Every `WorkspaceError` becomes a `WorkflowEngineError` here — `creationRejection` is total over
 * its code union — so what is left is infrastructure: Git, the database, the state file, project
 * configuration. None of it is a placement the person chose badly, and all of it is reported as
 * itself at the API boundary rather than dressed up as a workflow rejection.
 */
export type PlacementInfrastructureError = Exclude<WorkspaceServiceError, WorkspaceError>;

/**
 * What `resolvePlacement` reads, and the one service call it makes.
 *
 * `preflightWorktreeCreation` allocates nothing — it answers "could this creation happen, and with
 * what facts" — so this whole function is still read-only. That is the property the rejection tests
 * assert on: a refused launch has neither written a row nor called anything that creates.
 */
export interface PlacementDeps {
  readonly runs: Pick<WorkflowRunsRepositoryService, 'listByDestinationSurface' | 'findAttachment'>;
  readonly workspace: {
    readonly findWorktree: (
      worktreeId: number,
    ) => Effect.Effect<
      { readonly id: number; readonly projectId: number; readonly path: string } | null,
      DatabaseError
    >;
  };
  readonly workspaceService: {
    readonly preflightWorktreeCreation: (input: {
      readonly projectId: number;
      readonly branch: string;
      readonly fromRef: string;
    }) => Effect.Effect<{ commit: string; checkoutPath: string }, WorkspaceServiceError>;
  };
  readonly surfaceRepository: {
    readonly findSurface: (
      surfaceId: number,
    ) => Effect.Effect<{ readonly id: number; readonly worktreeId: number } | null, DatabaseError>;
  };
}

export interface ResolvePlacementInput {
  readonly workflowKey: string;
  readonly origin: WorkflowOrigin & { readonly surfaceId: number };
  readonly project: LaunchProject;
  readonly selection: PlacementSelection;
}

/**
 * The requested placement, checked against live rows and Git before anything is allocated.
 *
 * Evaluated in order, and the first failure is the rejection. No run row exists yet, which is the
 * whole point: an impossible destination is a launch the person is told about immediately, not a
 * retained failure they have to go and inspect.
 *
 * Three things this does *not* do, each for a stated reason. It does not reconcile — a read is not a
 * reservation (ADRs 0001, 0002), and preparation re-checks liveness per step. It does not create
 * anything, including the branch a `create` choice names. And it does not re-derive anything later:
 * the returned `ResolvedPlacement` is what preparation acts on, so a `create` worktree carries the
 * commit its `fromRef` pointed at *now*, and preparation creates from that commit even if the
 * branch has moved (criterion 7).
 */
export function resolvePlacement(
  deps: PlacementDeps,
  input: ResolvePlacementInput,
): Effect.Effect<ResolvedPlacement, WorkflowEngineError | PlacementInfrastructureError> {
  return Effect.gen(function* () {
    const { request } = input.selection;
    const worktree = yield* resolveWorktree(deps, input);
    const resolvedWorktreeId =
      worktree.kind === 'reuse' ? worktree.worktreeId : (null as number | null);

    const surface = yield* resolveSurface(deps, input, resolvedWorktreeId);

    // Occupancy applies only to a surface this launch is *taking over*. A surface it is about to
    // create cannot already hold a run, and checking a title against the attachment table would be
    // meaningless. The authority remains the partial unique index re-checked by the commit; this is
    // the pre-check that turns the common case into a useful message instead of a retained failure.
    if (surface.kind === 'reuse') {
      const occupant = yield* firstAttached(
        deps,
        yield* deps.runs.listByDestinationSurface(surface.surfaceId),
      );
      if (occupant !== null) {
        return yield* Effect.fail(
          new WorkflowEngineError({
            code: 'workflow_surface_attached',
            message: `Surface ${surface.surfaceId} already has a workflow attached. Dismiss it before starting another.`,
            workflowKey: input.workflowKey,
            activeWorkflowRunId: occupant,
            surfaceId: surface.surfaceId,
          }),
        );
      }
    }

    return {
      source: input.selection.source,
      request,
      projectId: input.project.id,
      worktree,
      surface,
    } satisfies ResolvedPlacement;
  });
}

function resolveWorktree(
  deps: PlacementDeps,
  input: ResolvePlacementInput,
): Effect.Effect<
  ResolvedPlacement['worktree'],
  WorkflowEngineError | PlacementInfrastructureError
> {
  const choice = input.selection.request.worktree;
  switch (choice.kind) {
    // Nothing to check: `buildOrigin` already validated the origin worktree against live rows, and
    // re-reading it here would only widen the window in which it could change.
    case 'current':
      return Effect.succeed({
        kind: 'reuse',
        worktreeId: input.origin.worktreeId,
        worktreePath: input.origin.worktreePath,
      });

    case 'existing':
      return Effect.gen(function* () {
        const row = yield* deps.workspace.findWorktree(choice.worktreeId);
        if (!row) {
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'worktree_not_found',
              message: `Worktree ${choice.worktreeId} was not found.`,
              workflowKey: input.workflowKey,
              worktreeId: choice.worktreeId,
            }),
          );
        }
        if (row.projectId !== input.project.id) {
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_placement_invalid',
              placementIssue: 'worktree_not_in_project',
              message: `Worktree ${row.id} belongs to project ${row.projectId}, not the launch project ${input.project.id}.`,
              workflowKey: input.workflowKey,
              worktreeId: row.id,
              projectId: input.project.id,
            }),
          );
        }
        return { kind: 'reuse', worktreeId: row.id, worktreePath: row.path } as const;
      });

    case 'create':
      return Effect.gen(function* () {
        const branch = choice.branch.trim();
        const preflight = yield* deps.workspaceService
          .preflightWorktreeCreation({
            projectId: input.project.id,
            branch,
            fromRef: choice.fromRef,
          })
          .pipe(
            Effect.catchIf(
              (error): error is WorkspaceError => error instanceof WorkspaceError,
              (error) => Effect.fail(creationRejection(error, input, branch, choice.fromRef)),
            ),
          );
        return {
          kind: 'create',
          branch,
          fromRef: choice.fromRef,
          baseCommit: preflight.commit,
          checkoutPath: preflight.checkoutPath,
        } as const;
      });
  }
}

/**
 * The workspace's creation vocabulary, mapped into the workflow's.
 *
 * Mapped rather than renamed: every reason here already exists on the wire, and the identities the
 * person needs — which branch, which ref, which worktree already holds it — travel with it.
 *
 * A `DatabaseError` or `GitCommandError` never reaches this function. Those are infrastructure, not
 * a placement the person chose badly, and they propagate to the API boundary as themselves.
 */
function creationRejection(
  error: WorkspaceError,
  input: ResolvePlacementInput,
  branch: string,
  fromRef: string,
): WorkflowEngineError {
  const common = { message: error.message, workflowKey: input.workflowKey } as const;
  switch (error.code) {
    case 'worktrees_not_supported':
      return new WorkflowEngineError({
        ...common,
        code: 'workflow_worktree_creation_unsupported',
        projectId: input.project.id,
      });
    case 'invalid_branch_name':
      return new WorkflowEngineError({ ...common, code: 'workflow_branch_invalid', branch });
    // Both identities, because the person has to act on the pair: `baseRef` is what could not be
    // resolved, `branch` is what they were trying to create from it. Either alone leaves them
    // guessing which half of the request to change.
    case 'base_ref_not_found':
      return new WorkflowEngineError({
        ...common,
        code: 'workflow_base_ref_not_found',
        baseRef: fromRef,
        branch,
      });
    // The commonest collision of all reports `branch`, not `worktree`: creating a worktree creates
    // its branch too, so a branch Isagi already has a worktree for is caught by the branch list
    // first. `worktree` is reached only for a stale row whose branch Git no longer has — a real
    // state precisely because the preflight does not reconcile.
    case 'branch_exists':
      return new WorkflowEngineError({
        ...common,
        code: 'workflow_environment_collision',
        collision: 'branch',
        branch,
      });
    case 'worktree_exists':
      return new WorkflowEngineError({
        ...common,
        code: 'workflow_environment_collision',
        collision: 'worktree',
        branch,
        ...(error.worktreeId === undefined ? {} : { worktreeId: error.worktreeId }),
      });
    case 'checkout_path_exists':
    case 'checkout_path_registered':
      return new WorkflowEngineError({
        ...common,
        code: 'workflow_environment_collision',
        collision: 'checkout_path',
        branch,
      });
    // The project itself is gone or unreadable. The worktree the launch asked for cannot exist,
    // which is the honest thing to say; `project_not_present` also leaves the project marked
    // missing, so the workspace surfaces it too.
    case 'project_not_found':
    case 'project_not_present':
      return new WorkflowEngineError({
        ...common,
        code: 'worktree_not_found',
        projectId: input.project.id,
      });
    default:
      /**
       * Unreachable by construction, and worth saying why rather than leaving the next reader to
       * re-derive it.
       *
       * The preflight's chain is `requirePresentProject` → `requireGitProject` →
       * `ensureProjectPathAvailable` → `validateBranchName` → `listLocalBranches` →
       * `findProjectWorktreeByBranch` → `resolveCommit` → `ensureCheckoutPathAvailable`, so the
       * codes it can raise are exactly the nine the arms above name. Every other member of
       * `WorkspaceError['code']` belongs to an endpoint this is not.
       *
       * `checkout_parent_unavailable` is the one worth calling out, because it looks like it
       * belongs with the two checkout-path collisions and does not. It is raised only by
       * `prepareCheckoutParent`, a `mkdirSync` inside `openWorktree` — allocation time, which the
       * preflight never reaches — and the workspace boundary classifies it as a 500 while mapping
       * the two path collisions to 409. Reporting it here as a collision would tell a person their
       * checkout path was taken when the truth is the runtime could not create a directory.
       * Preparation owns it: program design §4.4's `mapWorkspaceFailure` folds it into
       * `checkout_path_unavailable`, in the phase where `openWorktree` actually runs.
       *
       * A load failure is the honest answer for anything that does somehow arrive: the message
       * carries what happened, and no placement reason is invented for it.
       */
      return new WorkflowEngineError({ ...common, code: 'workflow_load_failed' });
  }
}

function resolveSurface(
  deps: PlacementDeps,
  input: ResolvePlacementInput,
  resolvedWorktreeId: number | null,
): Effect.Effect<ResolvedPlacement['surface'], WorkflowEngineError | DatabaseError> {
  const choice = input.selection.request.surface;
  switch (choice.kind) {
    /**
     * Compatibility is membership, not kind.
     *
     * `buildOrigin` already guarantees the origin surface sits on the origin worktree, so the only
     * question left is whether the *resolved* worktree is that same one. A selector that found the
     * origin worktree through `listWorktrees()` and returned it as `existing` therefore passes; a
     * `create` worktree never can, because its surfaces do not exist yet.
     */
    case 'current':
      if (resolvedWorktreeId !== input.origin.worktreeId) {
        return Effect.fail(
          new WorkflowEngineError({
            code: 'workflow_placement_invalid',
            placementIssue: 'surface_not_on_worktree',
            message: `The current surface ${input.origin.surfaceId} is on worktree ${input.origin.worktreeId}, which is not where this run was placed.`,
            workflowKey: input.workflowKey,
            surfaceId: input.origin.surfaceId,
            worktreeId: input.origin.worktreeId,
          }),
        );
      }
      return Effect.succeed({ kind: 'reuse', surfaceId: input.origin.surfaceId });

    case 'existing':
      return Effect.gen(function* () {
        const row = yield* deps.surfaceRepository.findSurface(choice.surfaceId);
        if (!row) {
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'surface_not_found',
              message: `Surface ${choice.surfaceId} was not found.`,
              workflowKey: input.workflowKey,
              surfaceId: choice.surfaceId,
            }),
          );
        }
        if (row.worktreeId !== resolvedWorktreeId) {
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_placement_invalid',
              placementIssue: 'surface_not_on_worktree',
              message:
                resolvedWorktreeId === null
                  ? `Surface ${row.id} cannot be used with a worktree this launch has yet to create.`
                  : `Surface ${row.id} is on worktree ${row.worktreeId}, not worktree ${resolvedWorktreeId}.`,
              workflowKey: input.workflowKey,
              surfaceId: row.id,
              worktreeId: row.worktreeId,
            }),
          );
        }
        return { kind: 'reuse', surfaceId: row.id } as const;
      });

    case 'create':
      // The surfaces domain's own rule, imported rather than copied: one definition of what a
      // usable surface title is, applied identically at launch, at creation and at rename.
      return Effect.gen(function* () {
        const title = yield* validateSurfaceTitle(choice.title).pipe(
          Effect.mapError(
            (error: SurfaceError) =>
              new WorkflowEngineError({
                code: 'workflow_placement_invalid',
                placementIssue: 'invalid_surface_title',
                message: error.message,
                workflowKey: input.workflowKey,
              }),
          ),
        );
        return { kind: 'create', title } as const;
      });
  }
}

/** The run currently holding this surface's attachment, if any. */
export function firstAttached(
  deps: Pick<PlacementDeps, 'runs'>,
  candidates: readonly WorkflowRunRecord[],
): Effect.Effect<number | null, DatabaseError> {
  return Effect.reduce(candidates, null as number | null, (held, candidate) =>
    held !== null
      ? Effect.succeed(held)
      : deps.runs
          .findAttachment(candidate.id)
          .pipe(Effect.map((attachment) => (attachment ? candidate.id : null))),
  );
}
