import { Effect, Either } from 'effect';

import type { WorkflowLaunchOrigin } from '@isagi/contracts';

import type { SurfaceServiceShape } from '../../surfaces/index.js';
import type { WorkspaceRepositoryService } from '../../workspace/workspace.repository.js';
import type { WorkflowRunRecord } from '../persistence/records.js';
import type { WorkflowRunsRepositoryService } from '../persistence/runs.repository.js';
import { errorMessage } from '../state/pure.js';
import type { WorkflowArtifactCatalogService } from '../structure/artifact-catalog.js';
import {
  WorkflowLoadError,
  type AnyWorkflowDefinition,
  type LoadedWorkflowArtifact,
} from '../structure/loader.js';
import type {
  WorkflowPackageProvenance,
  WorkflowRegistryContext,
  WorkflowRegistryService,
} from '../structure/registry.js';
import { WorkflowEngineError, type WorkflowOrigin } from '../types.js';

/**
 * Starting a run.
 *
 * The order is load → place → `command` → occupancy → `validate` → create, and every step before
 * the last leaves no run row behind: a workflow that cannot be loaded, a destination that is not
 * there, a command manifest that throws or inputs the author refuses are all launch failures, not
 * runs that immediately fail.
 *
 * `init` is *not* in that list, and its absence is the point. Initialization runs as the root
 * frame's first `graph_entry` segment, so a failed initialization is a retained, inspectable,
 * retryable segment rather than a launch that vanished. That is also what makes "recovery does not
 * repeat graph initialization" a statement about a committed fact rather than a hope.
 */
export interface LaunchDeps {
  readonly runs: WorkflowRunsRepositoryService;
  readonly registry: WorkflowRegistryService;
  readonly catalog: WorkflowArtifactCatalogService;
  readonly workspace: WorkspaceRepositoryService;
  readonly surfaces: SurfaceServiceShape;
}

export interface LaunchInput {
  readonly workflowKey: string;
  readonly inputs: Record<string, unknown>;
  readonly origin: WorkflowLaunchOrigin;
}

export interface DescriptorListing {
  readonly workflowKey: string;
  readonly result:
    | { readonly ok: true; readonly definition: AnyWorkflowDefinition }
    | { readonly ok: false; readonly error: WorkflowLoadError };
}

export function startWorkflow(
  deps: LaunchDeps,
  input: LaunchInput,
): Effect.Effect<
  WorkflowRunRecord,
  | WorkflowEngineError
  | import('../../persistence/index.js').DatabaseError
  | import('../persistence/payload-store.js').PayloadPublishError
> {
  return Effect.gen(function* () {
    const artifact = yield* resolveArtifact(deps, input.workflowKey, input.origin.worktreeId);
    const definition = artifact.definition;

    // Placement is validated against live rows before any author code runs, so a command manifest is
    // never built for a destination that has already gone.
    const origin = yield* buildOrigin(deps, input.origin);

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

    // One attached run per surface, including a terminal one until it is dismissed. Checked here for
    // a useful message and enforced by a partial unique index, so a race cannot create a second.
    const occupant = yield* deps.runs.listByDestinationSurface(origin.surfaceId);
    const attached = yield* firstAttached(deps, occupant);
    if (attached) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_surface_attached',
          message: `Surface ${origin.surfaceId} already has a workflow attached. Dismiss it before starting another.`,
          workflowKey: input.workflowKey,
          activeWorkflowRunId: attached,
          surfaceId: origin.surfaceId,
        }),
      );
    }

    yield* Effect.tryPromise({
      try: async () => definition.validate(origin, input.inputs),
      catch: (cause) =>
        new WorkflowEngineError({
          code: 'workflow_inputs_rejected',
          message: errorMessage(cause),
          workflowKey: input.workflowKey,
        }),
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
      // Origin and destination are split concepts that happen to coincide at launch: the origin is
      // descriptive provenance that may name a pane the person has since closed, while the
      // destination is where work is placed and every nested frame inherits it.
      destination: {
        worktreeId: origin.worktreeId,
        worktreePath: origin.worktreePath,
        surfaceId: origin.surfaceId,
      },
      attachment: { worktreeId: origin.worktreeId, surfaceId: origin.surfaceId },
    });

    if (!created.ok) {
      if (created.rejection.kind === 'surface_busy') {
        return yield* Effect.fail(
          new WorkflowEngineError({
            code: 'workflow_surface_attached',
            message: `Surface ${origin.surfaceId} already has a workflow attached.`,
            workflowKey: input.workflowKey,
            activeWorkflowRunId: created.rejection.runId,
            surfaceId: origin.surfaceId,
          }),
        );
      }
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_load_failed',
          message: `The run could not be created: ${created.rejection.kind}.`,
          workflowKey: input.workflowKey,
        }),
      );
    }
    return created.value.run;
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
    return yield* Effect.forEach(snapshot, (entry) =>
      deps.registry.loadDiscovered(entry).pipe(
        Effect.map(
          (artifact): DescriptorListing => ({
            workflowKey: entry.workflowKey,
            result: { ok: true, definition: artifact.definition },
          }),
        ),
        Effect.catchAll((error) =>
          Effect.succeed<DescriptorListing>({
            workflowKey: entry.workflowKey,
            result: { ok: false, error },
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

/** The run currently holding this surface's attachment, if any. */
function firstAttached(deps: LaunchDeps, candidates: readonly WorkflowRunRecord[]) {
  return Effect.reduce(candidates, null as number | null, (held, candidate) =>
    held !== null
      ? Effect.succeed(held)
      : deps.runs
          .findAttachment(candidate.id)
          .pipe(Effect.map((attachment) => (attachment ? candidate.id : null))),
  );
}
