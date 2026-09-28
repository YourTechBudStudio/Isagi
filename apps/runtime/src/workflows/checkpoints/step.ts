import { Effect, Either } from 'effect';

import { applyFailure, type StepFailure } from '../engine/chain.js';
import type { SavedResult } from '../engine/results.js';
import type { EngineRuntime } from '../engine/runtime.js';
import { isolate } from '../state/isolation.js';
import { errorMessage, evaluatePure } from '../state/pure.js';
import { insertCheckpoint } from '../store/checkpoints.js';
import { fromJson, toJson, type ExecutionRow, type RunRow } from '../store/rows.js';
import { getRun } from '../store/runs.js';
import { getExecution, getInvocation, updateExecution } from '../store/tree.js';
import { nodeOf } from '../structure/graph.js';
import type { LoadedWorkflowArtifact } from '../structure/loader.js';
import { captureScopes } from './capture.js';
import { normalizeCheckpointPlan } from './plan.js';

/**
 * A checkpoint node's one side-effecting step, the counterpart of running an operation's function.
 *
 * ```text
 * plan    = prepare(state)                     pure; stage checkpoint_prepare on failure
 * commit  = HEAD of the run's checkout         null for a folder project or an unborn repository
 * scopes  = exact copies into the content store; stage checkpoint_capture on failure
 * in ONE transaction: insert the checkpoint, save { type: 'complete', update: {}, checkpointId }
 *                     as the result, set checkpoint_id and the title, append checkpoint_captured
 * ```
 *
 * The saved result then routes like any completed operation, and a Retry copies it rather than
 * capturing again. A failure saves nothing, so a Retry captures again.
 */
export function captureCheckpoint(
  rt: EngineRuntime,
  artifact: LoadedWorkflowArtifact,
  run: RunRow,
  leaf: ExecutionRow,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const invocation = yield* rt.read('workflow_read_invocation', (db) =>
      getInvocation(db, leaf.invocationId),
    );
    const graph = invocation ? artifact.graphs.get(invocation.graphKey) : undefined;
    const node = graph ? nodeOf(graph, leaf.nodeId) : null;
    const at = { graphKey: invocation?.graphKey ?? '', nodeId: leaf.nodeId };
    const fail = (stage: StepFailure['stage'], message: string) =>
      failCapture(rt, run, leaf, { stage, message, ...at });

    if (!invocation || !node || node.isagiKind !== 'checkpoint-node') {
      return yield* fail(
        'checkpoint_prepare',
        `Node '${leaf.nodeId}' is not a checkpoint node in this build.`,
      );
    }
    if (run.worktreePath === null) {
      return yield* fail(
        'checkpoint_capture',
        `Workflow run ${run.id} has no worktree to capture.`,
      );
    }

    const prepared = evaluatePure({
      what: `checkpoint '${leaf.nodeId}' prepare`,
      run: () => node.prepare(isolate(fromJson(invocation.stateJson))),
    });
    if (!prepared.ok) return yield* fail('checkpoint_prepare', prepared.message);
    const plan = normalizeCheckpointPlan(prepared.value, {
      nodeId: leaf.nodeId,
      title: node.title,
    });
    if (!plan.ok) return yield* fail('checkpoint_prepare', plan.message);

    const captured = yield* Effect.either(
      Effect.gen(function* () {
        const project = yield* rt.deps.places.workspace.findProject(run.projectId);
        if (!project) {
          return yield* Effect.fail(new Error(`Project ${run.projectId} no longer exists.`));
        }
        const commitSha =
          project.kind === 'git'
            ? yield* rt.deps.checkpoints
                .headCommit(run.worktreePath as string)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new Error(
                        `Git could not read HEAD in ${run.worktreePath}: ${gitDetail(cause)}`,
                      ),
                  ),
                )
            : null;
        const scopes = yield* captureScopes(
          run.worktreePath as string,
          plan.value.scopes,
          rt.deps.checkpoints.content,
        );
        return { commitSha, scopes };
      }),
    );
    if (Either.isLeft(captured)) {
      return yield* fail('checkpoint_capture', captureMessage(captured.left));
    }

    yield* rt.commit('workflow_save_checkpoint', (db, emit) => {
      const execution = getExecution(db, leaf.id);
      if (!execution || execution.resultJson !== null) return;
      // Saved even when the run was paused or cancelled meanwhile, as an operation's result is.
      const checkpoint = insertCheckpoint(db, {
        runId: run.id,
        executionId: leaf.id,
        title: plan.value.title,
        commitSha: captured.right.commitSha,
        scopes: captured.right.scopes,
      });
      const result: SavedResult = { type: 'complete', update: {}, checkpointId: checkpoint.id };
      updateExecution(db, leaf.id, {
        resultJson: toJson(result),
        checkpointId: checkpoint.id,
        label: plan.value.title,
      });
      emit({
        runId: run.id,
        executionId: leaf.id,
        category: 'node',
        kind: 'checkpoint_captured',
        message: `${plan.value.title}: checkpoint ${checkpoint.id} saved`,
        data: { checkpointId: checkpoint.id },
      });
    });
  });
}

function failCapture(rt: EngineRuntime, run: RunRow, leaf: ExecutionRow, failure: StepFailure) {
  return rt.commit('workflow_fail_checkpoint', (db, emit) => {
    const current = getRun(db, run.id);
    const execution = getExecution(db, leaf.id);
    if (!current || !execution || execution.status !== 'running') return;
    if (current.status !== 'running' && current.status !== 'waiting') return;
    applyFailure(db, emit, current, execution, failure);
  });
}

function captureMessage(cause: unknown): string {
  const text = errorMessage(cause);
  return text.startsWith('Scope ') || text.startsWith('Could not') || text.startsWith('Git ')
    ? text
    : `Checkpoint capture failed: ${text}`;
}

function gitDetail(cause: unknown): string {
  const stderr = (cause as { readonly stderr?: unknown }).stderr;
  return typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : errorMessage(cause);
}
