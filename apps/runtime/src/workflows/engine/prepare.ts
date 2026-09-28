import { Effect, Either } from 'effect';

import { errorMessage } from '../state/pure.js';
import { fromJson, now, toJson, type RunPlacement, type RunRow } from '../store/rows.js';
import { getRun, updateRun } from '../store/runs.js';
import { findRootInvocation } from '../store/tree.js';
import { applyEntry, applyFailure, computeEntry } from './chain.js';
import { destinationOf } from './drive.js';
import type { EngineRuntime } from './runtime.js';

/**
 * Preparing a run's environment, then entering its root graph.
 *
 * ```text
 * worktree to create and none saved yet → create it (with its setup hooks) → save worktree_id/path
 * created here but setup not done       → run setup hooks → save setup_done
 * surface to create and none saved yet  → create it → save surface_id
 * ```
 *
 * Each step saves what it made and appends an environment event, so the run's history shows exactly
 * what was created. A throw fails the run at stage `environment`; Retry calls this again and the
 * saved ids skip the finished steps. Nothing created is ever deleted. A new worktree is created
 * from the commit its ref resolved to at launch, never from the ref again.
 */
export function prepareAndStart(rt: EngineRuntime, runId: number): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const prepared = yield* prepare(rt, runId).pipe(Effect.either);
    if (Either.isLeft(prepared)) {
      yield* rt.commit('workflow_preparation_failed', (db, emit) => {
        const run = getRun(db, runId);
        if (!run || run.status !== 'preparing') return;
        const message = errorMessage(prepared.left);
        updateRun(db, runId, {
          status: 'failed',
          errorJson: toJson({ stage: 'environment', message }),
          endedAt: now(),
        });
        emit({
          runId,
          category: 'environment',
          kind: 'preparation_failed',
          message,
          data: { message },
        });
        emit({
          runId,
          category: 'run',
          kind: 'run_failed',
          message,
          data: { stage: 'environment' },
        });
      });
      return;
    }
    if (prepared.right === 'stopped') return;
    yield* enterRoot(rt, runId);
  });
}

class PreparationFailure extends Error {}

/** Returns 'stopped' when the run stopped preparing meanwhile (Cancel). */
function prepare(rt: EngineRuntime, runId: number): Effect.Effect<'ready' | 'stopped', unknown> {
  return Effect.gen(function* () {
    const places = rt.deps.places;
    const current = () => rt.read('workflow_read_run', (db) => getRun(db, runId));
    let run = yield* current();
    if (!run || run.status !== 'preparing') return 'stopped';
    const placement = fromJson<RunPlacement>(run.placementJson);
    const worktreeChoice = placement.request.worktree;
    const surfaceChoice = placement.request.surface;

    if (worktreeChoice.kind === 'create') {
      if (run.worktreeId === null) {
        const opened = yield* places.workspaceService.openWorktree({
          projectId: run.projectId,
          request: {
            branch: worktreeChoice.branch,
            base: { kind: 'commit', commit: placement.baseCommit ?? '' },
            mode: 'create_new',
          },
        });
        const worktree = yield* places.workspace.findWorktree(opened.worktreeId);
        const setupDone = opened.status === 'created';
        yield* rt.commit('workflow_worktree_created', (db, emit) => {
          updateRun(db, runId, {
            worktreeId: opened.worktreeId,
            worktreePath: worktree?.path ?? null,
            setupDone,
          });
          emit({
            runId,
            category: 'environment',
            kind: 'worktree_created',
            message: `Created worktree ${opened.branch}`,
            data: {
              worktreeId: opened.worktreeId,
              path: worktree?.path ?? null,
              branch: opened.branch,
              baseCommit: placement.baseCommit,
            },
          });
          emit({
            runId,
            category: 'environment',
            kind: setupDone ? 'setup_finished' : 'setup_failed',
            message: setupDone ? 'Setup finished' : 'Setup failed',
            data: opened.setup,
          });
        });
        if (opened.status === 'created_setup_failed') {
          return yield* Effect.fail(
            new PreparationFailure(`Worktree setup failed: ${opened.setup.message}`),
          );
        }
      } else if (!run.setupDone) {
        const setup = yield* places.workspaceService.runWorktreeSetup({
          projectId: run.projectId,
          worktreeId: run.worktreeId,
        });
        const done = setup.status !== 'failed';
        yield* rt.commit('workflow_setup', (db, emit) => {
          if (done) updateRun(db, runId, { setupDone: true });
          emit({
            runId,
            category: 'environment',
            kind: done ? 'setup_finished' : 'setup_failed',
            message: done ? 'Setup finished' : 'Setup failed',
            data: setup,
          });
        });
        if (setup.status === 'failed') {
          return yield* Effect.fail(
            new PreparationFailure(`Worktree setup failed: ${setup.message}`),
          );
        }
      }
    } else if (run.worktreeId === null || !(yield* places.workspace.findWorktree(run.worktreeId))) {
      return yield* Effect.fail(
        new PreparationFailure(
          `Worktree ${run.worktreeId ?? '(none)'} no longer exists, so the run has nowhere to work.`,
        ),
      );
    }

    run = yield* current();
    if (!run || run.status !== 'preparing') return 'stopped';
    if (surfaceChoice.kind === 'create') {
      if (run.surfaceId === null) {
        const worktreeId = run.worktreeId as number;
        const surface = yield* places.surfaces.createSinglePaneSurface({
          worktreeId,
          titleBase: surfaceChoice.title,
        });
        yield* rt.commit('workflow_surface_created', (db, emit) => {
          updateRun(db, runId, { surfaceId: surface.surfaceId });
          emit({
            runId,
            category: 'environment',
            kind: 'surface_created',
            message: `Created surface ${surface.title}`,
            data: { surfaceId: surface.surfaceId, title: surface.title },
          });
        });
      }
    } else if (run.surfaceId === null) {
      // A current or existing surface is saved at launch; null means it was deleted since.
      const requested =
        surfaceChoice.kind === 'existing'
          ? `Surface ${surfaceChoice.surfaceId}`
          : 'The launch surface';
      return yield* Effect.fail(
        new PreparationFailure(
          `${requested} no longer exists, and a run never replaces a surface it did not create.`,
        ),
      );
    }
    return 'ready';
  });
}

/** Opens the root graph invocation (its `init`) and starts driving. Skipped if it already exists. */
function enterRoot(rt: EngineRuntime, runId: number): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const run = yield* rt.read('workflow_read_run', (db) => getRun(db, runId));
    if (!run || run.status !== 'preparing') return;
    const artifact = yield* rt.loadArtifact(run.artifactHash, run.workflowKey);
    yield* rt.commit('workflow_enter_root', (db, emit) => {
      const current = getRun(db, runId) as RunRow;
      if (current.status !== 'preparing') return;
      if (findRootInvocation(db, runId)) {
        updateRun(db, runId, { status: 'running' });
        return;
      }
      const root = artifact.definition.graph as Parameters<typeof computeEntry>[0];
      const destination = destinationOf(current);
      const entry = destination
        ? computeEntry(root, {
            destination,
            depth: 0,
            parameters: () => ({ ok: true, value: fromJson(current.inputsJson) }),
          })
        : ({
            ok: false,
            failure: {
              stage: 'graph_init',
              message: `Workflow run ${runId} has no worktree and surface to work in.`,
              graphKey: root.key,
            },
          } as const);
      if (!entry.ok) {
        applyFailure(db, emit, current, null, entry.failure);
        return;
      }
      updateRun(db, runId, { status: 'running' });
      applyEntry(db, emit, current, entry.value, null);
    });
    rt.kick(runId);
  });
}
