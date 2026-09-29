import type { StructureDiagnostic } from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { Effect, Either } from 'effect';

import type {
  WorkflowLaunchOrigin,
  WorkflowLoadFailureReason,
  WorkflowPlacementRequestDto,
} from '@isagi/contracts';

import { WorkflowEngineError } from '../errors.js';
import { checkSerializable, errorMessage } from '../state/pure.js';
import { storedParameters, toJson, type RunPlacement } from '../store/rows.js';
import { findRunOnSurface, insertRun } from '../store/runs.js';
import type { WorkflowCommandManifest, WorkflowOrigin } from '../types.js';
import { projectContext, resolveLatestBuild } from './builds.js';
import { resolvePlacement } from './environment/placement.js';
import { selectPlacement } from './environment/selection.js';
import type { LaunchProject } from './environment/types.js';
import { prepareAndStart } from './prepare.js';
import type { EngineRuntime } from './runtime.js';

/**
 * Starting a run.
 *
 * Load → origin → project → `command` → `parse` → placement (select, then validate against live
 * rows) → create the run → preparation. Every step before the run exists leaves no row behind: a
 * workflow that cannot load, an origin that is gone, a manifest that throws, a `parse` that refuses
 * or returns unstorable parameters, and an impossible placement are launch rejections, not failed
 * runs.
 *
 * `parse` runs exactly once per run, here. The parameters it returns are stored on the run and are
 * the only thing placement, preparation, its Retry and the root graph's `init` ever see of the
 * launch; the raw inputs are kept for display and relaunch only.
 *
 * The run is created `preparing` with whatever is already known (a current or existing worktree
 * and surface). Preparation, the root graph's `init` and driving then continue in the background,
 * so the launch returns as soon as the run exists.
 */
export interface LaunchInput {
  readonly workflowKey: string;
  readonly inputs: Record<string, unknown>;
  readonly origin: WorkflowLaunchOrigin;
  /** A caller's explicit placement. It beats the workflow's `placement` hook. */
  readonly placement?: WorkflowPlacementRequestDto | undefined;
}

export function launch(
  rt: EngineRuntime,
  input: LaunchInput,
): Effect.Effect<{ readonly runId: number; readonly workflowKey: string }, unknown> {
  return Effect.gen(function* () {
    const places = rt.deps.places;
    const origin = yield* buildOrigin(rt, input.origin);
    const project = yield* requireProject(rt, origin.worktreeId);
    const build = yield* resolveLatestBuild(
      rt,
      input.workflowKey,
      yield* projectContext(rt, project.id),
    );
    const definition = build.definition;

    const manifest = yield* Effect.tryPromise({
      try: async () => definition.command(origin),
      catch: (cause) =>
        new WorkflowEngineError({
          code: 'workflow_command_failed',
          message: errorMessage(cause),
          workflowKey: input.workflowKey,
          worktreeId: origin.worktreeId,
          surfaceId: origin.surfaceId ?? undefined,
        }),
    });
    const parsed = yield* Effect.tryPromise({
      try: async () => definition.parse(origin, input.inputs),
      catch: (cause) =>
        new WorkflowEngineError({
          code: 'workflow_parse_rejected',
          message: errorMessage(cause),
          workflowKey: input.workflowKey,
        }),
    });
    // Serialized once: placement, the stored row and the root graph's `init` all see this value.
    const parametersJson = yield* storableParameters(parsed, input.workflowKey);

    const selection = yield* selectPlacement(
      { workspace: places.workspace, surfaceRepository: places.surfaceRepository },
      {
        definition,
        workflowKey: input.workflowKey,
        origin,
        project,
        parameters: storedParameters(parametersJson),
        placement: input.placement,
        commandTitle: manifest.title,
      },
    );
    const resolved = yield* resolvePlacement(
      {
        workspace: places.workspace,
        workspaceService: places.workspaceService,
        surfaceRepository: places.surfaceRepository,
      },
      { workflowKey: input.workflowKey, origin, project, selection },
    );

    const placement: RunPlacement = {
      source: resolved.source,
      request: resolved.request,
      baseCommit: resolved.worktree.kind === 'create' ? resolved.worktree.baseCommit : null,
    };
    const surfaceId = resolved.surface.kind === 'reuse' ? resolved.surface.surfaceId : null;
    // Checked in the transaction that creates the run, so two launches cannot both take a surface.
    const created = yield* rt.commit('workflow_launch', (db, emit) => {
      const occupant = surfaceId === null ? null : findRunOnSurface(db, surfaceId);
      if (occupant) return { busy: occupant.id } as const;
      const run = insertRun(db, {
        projectId: project.id,
        workflowKey: input.workflowKey,
        title: manifest.title,
        artifactHash: build.artifactHash,
        status: 'preparing',
        inputsJson: toJson(input.inputs),
        parametersJson,
        placementJson: toJson(placement),
        originWorktreeId: origin.worktreeId,
        originWorktreePath: origin.worktreePath,
        originSurfaceId: origin.surfaceId,
        originPaneId: origin.paneId ?? null,
        originAgentSessionId: origin.agentSessionId ?? null,
        worktreeId: resolved.worktree.kind === 'reuse' ? resolved.worktree.worktreeId : null,
        worktreePath: resolved.worktree.kind === 'reuse' ? resolved.worktree.worktreePath : null,
        setupDone: false,
        surfaceId,
      });
      emit({
        runId: run.id,
        category: 'run',
        kind: 'run_launched',
        message: `Launched ${manifest.title}`,
        data: { workflowKey: input.workflowKey, artifactHash: build.artifactHash, placement },
      });
      return { run } as const;
    });
    if ('busy' in created) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_surface_busy',
          message: `Surface ${surfaceId} already has a workflow run attached. Dismiss it before starting another.`,
          workflowKey: input.workflowKey,
          surfaceId: surfaceId ?? undefined,
          activeWorkflowRunId: created.busy,
        }),
      );
    }

    rt.fork(prepareAndStart(rt, created.run.id), 'workflow preparation');
    return { runId: created.run.id, workflowKey: input.workflowKey };
  });
}

/**
 * The parameters `parse` returned, checked the way a subgraph's parameters are and serialized for
 * the run: a value JSON cannot hold is refused before anything exists. `undefined` is stored as
 * null, as it is for a subgraph. A refusal here is the author's defect rather than the person's
 * launch being turned down, so it has its own reason.
 */
function storableParameters(
  value: unknown,
  workflowKey: string,
): Effect.Effect<string, WorkflowEngineError> {
  const parameters = value ?? null;
  const unserializable = checkSerializable(parameters, 'parameters');
  return unserializable === null
    ? Effect.succeed(toJson(parameters))
    : Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_parameters_invalid',
          message: `The workflow's parse ${unserializable}`,
          workflowKey,
        }),
      );
}

/** One discoverable workflow, as the launch palette sees it. */
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

/**
 * Every discoverable workflow and whether it loads, for the launch palette. A workflow that cannot
 * be loaded, or whose `command` throws, is listed as unavailable rather than hiding the others.
 */
export function listWorkflowDescriptors(
  rt: EngineRuntime,
  originInput: WorkflowLaunchOrigin,
): Effect.Effect<readonly DescriptorListing[], unknown> {
  return Effect.gen(function* () {
    const origin = yield* buildOrigin(rt, originInput);
    const project = yield* requireProject(rt, origin.worktreeId);
    const snapshot = yield* rt.deps.registry
      .discover(yield* projectContext(rt, project.id))
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkflowEngineError({ code: 'workflow_discovery_failed', message: cause.message }),
        ),
      );
    return yield* Effect.forEach(snapshot.entries, (entry) =>
      Effect.gen(function* () {
        const loaded = yield* entry.load().pipe(Effect.either);
        if (Either.isLeft(loaded)) {
          return {
            workflowKey: entry.workflowKey,
            result: {
              ok: false,
              reason: loaded.left.reason,
              diagnostics: loaded.left.diagnostics ?? [],
            },
          } satisfies DescriptorListing;
        }
        const manifest = yield* Effect.tryPromise(async () =>
          loaded.right.definition.command(origin),
        ).pipe(Effect.either);
        return Either.isRight(manifest)
          ? ({
              workflowKey: entry.workflowKey,
              result: { ok: true, manifest: manifest.right },
            } satisfies DescriptorListing)
          : ({
              workflowKey: entry.workflowKey,
              result: { ok: false, reason: 'artifact_load_failed', diagnostics: [] },
            } satisfies DescriptorListing);
      }),
    );
  });
}

function requireProject(
  rt: EngineRuntime,
  worktreeId: number,
): Effect.Effect<LaunchProject, unknown> {
  return Effect.gen(function* () {
    const workspace = rt.deps.places.workspace;
    const worktree = yield* workspace.findWorktree(worktreeId);
    const project = worktree ? yield* workspace.findProject(worktree.projectId) : null;
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

/**
 * The origin, resolved against live rows: where the person launched from, including the pane and
 * agent session they had in view. Descriptive only; it never places work.
 *
 * A launch from a worktree with no surface open has a null surface, and then no pane or agent
 * session either: those only exist on a surface.
 */
function buildOrigin(
  rt: EngineRuntime,
  origin: WorkflowLaunchOrigin,
): Effect.Effect<WorkflowOrigin, unknown> {
  return Effect.gen(function* () {
    const worktree = yield* rt.deps.places.workspace.findWorktree(origin.worktreeId);
    if (!worktree) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'worktree_not_found',
          message: `Worktree ${origin.worktreeId} was not found.`,
          worktreeId: origin.worktreeId,
        }),
      );
    }
    if (origin.surfaceId === null) {
      const stray = origin.paneId ?? origin.agentSessionId ?? null;
      if (stray !== null) {
        return yield* Effect.fail(
          new WorkflowEngineError({
            code: 'workflow_launch_context_mismatch',
            message: 'A pane or agent session was supplied without the surface it belongs to.',
            worktreeId: worktree.id,
            paneId: origin.paneId ?? undefined,
            agentSessionId: origin.agentSessionId ?? undefined,
          }),
        );
      }
      return {
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        surfaceId: null,
        paneId: null,
        agentSessionId: null,
      };
    }
    const originSurfaceId = origin.surfaceId;
    const surface = yield* rt.deps.places.surfaces.getSurfaceDetail(originSurfaceId).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowEngineError({
            code: 'surface_not_found',
            message: errorMessage(cause),
            worktreeId: origin.worktreeId,
            surfaceId: originSurfaceId,
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
