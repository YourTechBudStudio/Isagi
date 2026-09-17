import type { StructureDiagnostic } from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { Effect, Either } from 'effect';

import type {
  WorkflowLaunchOrigin,
  WorkflowLoadFailureReason,
  WorkflowPlacementRequestDto,
} from '@isagi/contracts';

import type { SurfaceRepositoryService, SurfaceServiceShape } from '../../surfaces/index.js';
import type { WorkspaceServiceShape } from '../../workspace/index.js';
import type { WorkspaceRepositoryService } from '../../workspace/workspace.repository.js';
import type { WorkflowAttemptRecord, WorkflowRunRecord } from '../persistence/records.js';
import type { WorkflowRunsRepositoryService } from '../persistence/runs.repository.js';
import { errorMessage } from '../state/pure.js';
import type { WorkflowArtifactCatalogService } from '../structure/artifact-catalog.js';
import { WorkflowLoadError, type LoadedWorkflowArtifact } from '../structure/loader.js';
import type {
  WorkflowPackageProvenance,
  WorkflowRegistryContext,
  WorkflowRegistryService,
} from '../structure/registry.js';
import {
  WorkflowEngineError,
  type WorkflowCommandManifest,
  type WorkflowOrigin,
} from '../types.js';
import { resolvePlacement, type PlacementInfrastructureError } from './environment/placement.js';
import { selectPlacement } from './environment/selection.js';
import type { LaunchProject, ResolvedPlacement } from './environment/types.js';

/**
 * Starting a run.
 *
 * The order is load → origin → project → `command` → `validate` → select → resolve → create, and
 * every step before the last leaves no run row behind: a workflow that cannot be loaded, an origin
 * that is not there, a command manifest that throws, inputs the author refuses and a placement that
 * does not describe a usable destination are all launch failures, not runs that immediately fail.
 *
 * **Selection sits after `validate` and before `createRun`.** Where a run lands is decided by
 * exactly one of three sources — a caller override, the author's `environment` hook, or the
 * unchanged current/current default — and then statically validated against live rows and a
 * read-only Git preflight. Everything that could refuse the launch therefore happens while the
 * launch can still simply be refused.
 *
 * **Occupancy is checked on the destination, not the origin.** A surface busy with a run no longer
 * blocks a launch headed somewhere else, which is the behaviour change this story exists for.
 *
 * `init` is *not* in that list, and its absence is the point. Initialization runs as the root
 * frame's first `graph_entry` segment, so a failed initialization is a retained, inspectable,
 * retryable segment rather than a launch that vanished. That is also what makes "recovery does not
 * repeat graph initialization" a statement about a committed fact rather than a hope.
 *
 * Preparation is not here either, and for the same reason: `startWorkflow` returns the run **and
 * the claimed preparation attempt**, and the engine layer hands both to the preparation segment. A
 * launch that got as far as a run row owns a durable, retryable unit of work from then on.
 */
export interface LaunchDeps {
  readonly runs: WorkflowRunsRepositoryService;
  readonly registry: WorkflowRegistryService;
  readonly catalog: WorkflowArtifactCatalogService;
  readonly workspace: WorkspaceRepositoryService;
  readonly surfaces: SurfaceServiceShape;
  /**
   * The one owning-service call the launch path makes, and it allocates nothing.
   *
   * A `create` worktree choice is refused here — unsupported project, bad branch name, unknown base
   * ref, or a collision — rather than half way through preparation with a run row already behind it.
   */
  readonly workspaceService: Pick<WorkspaceServiceShape, 'preflightWorktreeCreation'>;
  /** Rows, not detail: discovery lists surfaces and validation checks one belongs where it claims. */
  readonly surfaceRepository: Pick<
    SurfaceRepositoryService,
    'findSurface' | 'listWorkspaceSurfaceMetadata'
  >;
  /**
   * Who holds a run's environment preparation.
   *
   * Launch-scoped, not the dispatcher's identity: the preparation segment is claimed by the launch
   * itself and held for the whole of preparation, and the dispatcher deliberately never claims it.
   */
  readonly owner: string;
  readonly ownerIncarnation: string;
}

export interface LaunchInput {
  readonly workflowKey: string;
  readonly inputs: Record<string, unknown>;
  readonly origin: WorkflowLaunchOrigin;
  /**
   * A caller's explicit choice of destination. It beats the author's `environment` hook, which beats
   * the default — a caller is a person or a CLI saying "put this here", and an override a workflow
   * could quietly overrule would not be one. It bypasses *selection*, never validation.
   */
  readonly placement?: WorkflowPlacementRequestDto | undefined;
}

/** What a launch hands to the preparation segment: the run, and the attempt it already holds. */
export interface LaunchedRun {
  readonly run: WorkflowRunRecord;
  readonly attempt: WorkflowAttemptRecord;
}

/**
 * One discoverable workflow, as the launch palette sees it.
 *
 * The manifest is built here rather than handed out as a definition, because building it means
 * calling the author's `command` — and author code is invoked by the engine, never by the API layer.
 * A workflow that cannot be loaded, or whose `command` throws, is listed as unavailable with a
 * reason instead of removing every other workflow from the palette.
 */
export interface DescriptorListing {
  readonly workflowKey: string;
  readonly result:
    | { readonly ok: true; readonly manifest: WorkflowCommandManifest }
    | {
        readonly ok: false;
        readonly reason: WorkflowLoadFailureReason;
        readonly diagnostics: readonly StructureDiagnostic[];
      };
}

export function startWorkflow(
  deps: LaunchDeps,
  input: LaunchInput,
): Effect.Effect<
  LaunchedRun,
  | WorkflowEngineError
  | PlacementInfrastructureError
  | import('../persistence/payload-store.js').PayloadPublishError
> {
  return Effect.gen(function* () {
    const artifact = yield* resolveArtifact(deps, input.workflowKey, input.origin.worktreeId);
    const definition = artifact.definition;

    // The origin is validated against live rows before any author code runs, so a command manifest
    // is never built for a place the person launched from that has since gone.
    const origin = yield* buildOrigin(deps, input.origin);
    const project = yield* requireProject(deps, origin.worktreeId);

    const manifest = yield* Effect.tryPromise({
      try: async () => definition.command(origin),
      catch: (cause) =>
        new WorkflowEngineError({
          code: 'workflow_command_failed',
          message: errorMessage(cause),
          workflowKey: input.workflowKey,
          worktreeId: origin.worktreeId,
          surfaceId: origin.surfaceId,
        }),
    });

    yield* Effect.tryPromise({
      try: async () => definition.validate(origin, input.inputs),
      catch: (cause) =>
        new WorkflowEngineError({
          code: 'workflow_inputs_rejected',
          message: errorMessage(cause),
          workflowKey: input.workflowKey,
        }),
    });

    // Where this run lands, decided and then checked. Both steps are still read-only: the placement
    // is a decision about live rows, and nothing exists yet that a failure would have to account for.
    const selection = yield* selectPlacement(deps, {
      definition,
      workflowKey: input.workflowKey,
      origin,
      project,
      inputs: input.inputs,
      placement: input.placement,
    });
    const resolved = yield* resolvePlacement(deps, {
      workflowKey: input.workflowKey,
      origin,
      project,
      selection,
    });

    const created = yield* deps.runs.createRun({
      workflowKey: input.workflowKey,
      title: manifest.title,
      rootGraphKey: definition.graph.key,
      artifactHash: artifact.artifactHash,
      rootFrame: { graphKey: definition.graph.key, parameters: { value: input.inputs } },
      origin: {
        worktreeId: origin.worktreeId,
        worktreePath: origin.worktreePath,
        surfaceId: origin.surfaceId,
        paneId: origin.paneId ?? null,
        agentSessionId: origin.agentSessionId ?? null,
      },
      preparation: {
        source: resolved.source,
        request: resolved.request,
        baseCommit: resolved.worktree.kind === 'create' ? resolved.worktree.baseCommit : null,
        checkoutPath: resolved.worktree.kind === 'create' ? resolved.worktree.checkoutPath : null,
      },
      // Claimed in the same transaction as the run. The dispatcher deliberately never claims this
      // segment, so the launch itself holds it for the whole of preparation — and there is no window
      // in which a preparing run exists with nothing an interruption could be attributed to.
      claim: {
        owner: deps.owner,
        ownerIncarnation: deps.ownerIncarnation,
        input: { value: preparationInput(resolved) },
      },
    });

    if (!created.ok) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_load_failed',
          message: `The run could not be created: ${created.rejection.kind}.`,
          workflowKey: input.workflowKey,
        }),
      );
    }

    return { run: created.value.run, attempt: created.value.attempt };
  });
}

/**
 * The claimed attempt's recorded input.
 *
 * It is the placement decision in full — what was asked for, who decided it, and the two facts a
 * `create` resolved to — so the attempt can say what it was about to do even if every row it names
 * is gone by the time somebody reads it.
 */
function preparationInput(resolved: ResolvedPlacement) {
  return {
    segment: 'environment_preparation',
    source: resolved.source,
    request: resolved.request,
    baseCommit: resolved.worktree.kind === 'create' ? resolved.worktree.baseCommit : null,
    checkoutPath: resolved.worktree.kind === 'create' ? resolved.worktree.checkoutPath : null,
  };
}

/**
 * The project a launch belongs to.
 *
 * Read once and passed down, because selection, validation and the worktree preflight all need the
 * same answer, and three independent reads could disagree with each other inside one launch.
 */
function requireProject(
  deps: LaunchDeps,
  worktreeId: number,
): Effect.Effect<
  LaunchProject,
  WorkflowEngineError | import('../../persistence/index.js').DatabaseError
> {
  return Effect.gen(function* () {
    const worktree = yield* deps.workspace.findWorktree(worktreeId);
    const project = worktree ? yield* deps.workspace.findProject(worktree.projectId) : null;
    if (!project) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'worktree_not_found',
          message: `Worktree ${worktreeId} has no project.`,
          worktreeId,
        }),
      );
    }
    return { id: project.id, name: project.name, kind: project.kind, rootPath: project.rootPath };
  });
}

/** Every discoverable workflow and whether it currently loads, for the launch palette. */
export function listWorkflowDescriptors(
  deps: LaunchDeps,
  origin: WorkflowLaunchOrigin,
): Effect.Effect<readonly DescriptorListing[], WorkflowEngineError> {
  return Effect.gen(function* () {
    const context = yield* registryContext(deps, origin.worktreeId);
    const snapshot = yield* discover(deps, context, undefined);
    const launchOrigin = yield* buildOrigin(deps, origin);
    return yield* Effect.forEach(snapshot, (entry) =>
      deps.registry.loadDiscovered(entry).pipe(
        Effect.flatMap((artifact) =>
          Effect.tryPromise({
            try: async () => artifact.definition.command(launchOrigin),
            // A manifest the author's own code refused to produce leaves the workflow unlistable
            // under this origin. It is reported as an artifact that did not yield a descriptor,
            // which is what actually happened, rather than as a structural problem it is not.
            catch: () =>
              new WorkflowLoadError({
                reason: 'artifact_load_failed',
                message: `Building the command manifest for ${entry.workflowKey} failed.`,
                workflowKey: entry.workflowKey,
              }),
          }),
        ),
        Effect.map(
          (manifest): DescriptorListing => ({
            workflowKey: entry.workflowKey,
            result: { ok: true, manifest },
          }),
        ),
        Effect.catchAll((error) =>
          Effect.succeed<DescriptorListing>({
            workflowKey: entry.workflowKey,
            result: {
              ok: false,
              reason: error.reason,
              diagnostics: error.diagnostics ?? [],
            },
          }),
        ),
      ),
    );
  });
}

/**
 * Discovery, then publication into the catalog.
 *
 * Publication is what makes the pin a durable, immutable fact before a run can reference it — a run
 * must never be created against a version the catalog has no record of.
 */
export function resolveArtifact(
  deps: LaunchDeps,
  workflowKey: string,
  worktreeId: number,
): Effect.Effect<LoadedWorkflowArtifact, WorkflowEngineError> {
  return Effect.gen(function* () {
    const context = yield* registryContext(deps, worktreeId);
    const entries = yield* discover(deps, context, workflowKey);
    const entry = entries.find((candidate) => candidate.workflowKey === workflowKey);
    if (!entry) {
      const known = entries.map((candidate) => candidate.workflowKey);
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'unknown_workflow_key',
          message:
            known.length === 0
              ? `No workflow named '${workflowKey}' was found, and no workflows are available here.`
              : `No workflow named '${workflowKey}' was found. Available: ${known.join(', ')}.`,
          workflowKey,
          knownWorkflowKeys: known,
        }),
      );
    }

    const provenance = entry.provenance;
    const packageRoot = provenance?.workflowPackageDirectory;
    // An in-memory test registration has no package directory to publish from; it loads through the
    // registry, which is also what keeps those workflows undiscoverable from the filesystem.
    const loaded = packageRoot
      ? yield* deps.catalog.publish({ workflowKey, packageRoot }).pipe(Effect.either)
      : yield* deps.registry.loadDiscovered(entry).pipe(Effect.either);
    if (Either.isRight(loaded)) return loaded.right;

    const failure = loaded.left;
    return yield* Effect.fail(
      new WorkflowEngineError({
        code: 'workflow_load_failed',
        message: failure instanceof WorkflowLoadError ? failure.message : errorMessage(failure),
        workflowKey,
        workflowLoadFailureReason:
          failure instanceof WorkflowLoadError ? failure.reason : 'artifact_load_failed',
        ...(provenance ? provenanceFields(provenance) : {}),
      }),
    );
  });
}

function provenanceFields(provenance: WorkflowPackageProvenance) {
  return {
    workflowPackageDirectory: provenance.workflowPackageDirectory,
    shadowedWorkflowPackageDirectories: provenance.shadowedWorkflowPackageDirectories,
  };
}

export function discover(
  deps: LaunchDeps,
  context: WorkflowRegistryContext,
  workflowKey: string | undefined,
) {
  return deps.registry.discover(context).pipe(
    Effect.map((snapshot) => snapshot.entries),
    Effect.mapError(
      (cause) =>
        new WorkflowEngineError({
          code: 'workflow_discovery_failed',
          message: cause.message,
          ...(workflowKey === undefined ? {} : { workflowKey }),
          ...(cause.workflowSourceDirectory === undefined
            ? {}
            : { workflowSourceDirectory: cause.workflowSourceDirectory }),
        }),
    ),
  );
}

export function registryContext(
  deps: LaunchDeps,
  worktreeId: number,
): Effect.Effect<WorkflowRegistryContext, WorkflowEngineError> {
  return Effect.gen(function* () {
    const worktree = yield* deps.workspace.findWorktree(worktreeId).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowEngineError({
            code: 'worktree_not_found',
            message: errorMessage(cause),
            worktreeId,
          }),
      ),
    );
    if (!worktree) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'worktree_not_found',
          message: `Worktree ${worktreeId} was not found.`,
          worktreeId,
        }),
      );
    }
    const project = yield* deps.workspace
      .findProject(worktree.projectId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    return { projectId: worktree.projectId, projectRoot: project?.rootPath ?? null };
  });
}

/**
 * The origin, resolved against live rows.
 *
 * Descriptive rather than operational: it records where a person launched from, including the pane
 * and agent session they had in view. It is never used to place work — that is the destination's
 * job — but it is still validated, because recording a pane that was never on this surface would
 * make the provenance misleading rather than merely incomplete.
 */
function buildOrigin(
  deps: LaunchDeps,
  origin: WorkflowLaunchOrigin,
): Effect.Effect<WorkflowOrigin & { readonly surfaceId: number }, WorkflowEngineError> {
  return Effect.gen(function* () {
    const worktree = yield* deps.workspace.findWorktree(origin.worktreeId).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowEngineError({
            code: 'worktree_not_found',
            message: errorMessage(cause),
            worktreeId: origin.worktreeId,
          }),
      ),
    );
    if (!worktree) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'worktree_not_found',
          message: `Worktree ${origin.worktreeId} was not found.`,
          worktreeId: origin.worktreeId,
        }),
      );
    }

    const surface = yield* deps.surfaces.getSurfaceDetail(origin.surfaceId).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowEngineError({
            code: 'surface_not_found',
            message: errorMessage(cause),
            worktreeId: origin.worktreeId,
            surfaceId: origin.surfaceId,
          }),
      ),
    );
    if (surface.worktreeId !== worktree.id) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'surface_worktree_mismatch',
          message: `Surface ${surface.id} belongs to worktree ${surface.worktreeId}, not worktree ${worktree.id}.`,
          worktreeId: worktree.id,
          surfaceId: surface.id,
        }),
      );
    }

    if (origin.agentSessionId !== undefined && origin.agentSessionId !== null) {
      const agentPane = surface.panes.find(
        (candidate) =>
          candidate.session?.kind === 'agent_session' &&
          candidate.session.agentSession.id === origin.agentSessionId,
      );
      if (!agentPane) {
        return yield* Effect.fail(
          new WorkflowEngineError({
            code: 'agent_session_not_on_surface',
            message: `Agent session ${origin.agentSessionId} was not found on surface ${surface.id}.`,
            worktreeId: worktree.id,
            surfaceId: surface.id,
          }),
        );
      }
      if (origin.paneId !== undefined && origin.paneId !== null && origin.paneId !== agentPane.id) {
        return yield* Effect.fail(
          new WorkflowEngineError({
            code: 'workflow_launch_context_mismatch',
            message: `Pane ${origin.paneId} was supplied with agent session ${origin.agentSessionId}, which belongs to pane ${agentPane.id} on surface ${surface.id}.`,
            worktreeId: worktree.id,
            surfaceId: surface.id,
            paneId: origin.paneId,
            agentSessionId: origin.agentSessionId,
          }),
        );
      }
      return {
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        surfaceId: surface.id,
        paneId: agentPane.id,
        agentSessionId: origin.agentSessionId,
      };
    }

    const paneId = origin.paneId ?? null;
    const pane =
      paneId === null ? null : (surface.panes.find((candidate) => candidate.id === paneId) ?? null);
    if (paneId !== null && !pane) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'pane_not_found',
          message: `Pane ${paneId} was not found on surface ${surface.id}.`,
          worktreeId: worktree.id,
          surfaceId: surface.id,
          paneId,
        }),
      );
    }
    return {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      surfaceId: surface.id,
      paneId,
      agentSessionId: pane?.session?.kind === 'agent_session' ? pane.session.agentSession.id : null,
    };
  });
}
