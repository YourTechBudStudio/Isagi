import { Effect } from 'effect';

import type { EngineRuntime } from '../engine/runtime.js';
import { WorkflowOperationFailed } from '../errors.js';
import { renderWorkflowPromptEffect, type WorkflowPromptOperation } from '../prompt-renderer.js';
import { errorMessage } from '../state/pure.js';
import { insertOperation, settleOperation, updateOperation } from '../store/operations.js';
import { toJson, type ExecutionRow, type OperationRow, type RunRow } from '../store/rows.js';
import { getRun } from '../store/runs.js';
import type {
  OperationContext,
  WorkflowAgentHarness,
  WorkflowPromptInput,
  WorkflowUiFeedback,
} from '../types.js';
import { startHeadless } from './headless.js';

/**
 * The `ctx` a node function receives.
 *
 * Each side-effecting call appends an operation row (the request, including the full prompt text),
 * performs the effect, and records what came back. The log is history only: nothing here looks at
 * earlier rows, so a Retry that runs the function again performs its effects again. A failure is
 * recorded on the row and rethrown to the author.
 *
 * The context closes when the function returns, so a stray promise cannot act for an execution that
 * has already moved on. Every call runs through the engine's author bridge, so engine shutdown
 * interrupts it and the author's promise rejects.
 *
 * `where` is the run's destination, which the driver has already checked exists.
 */
export function makeOperationContext(
  rt: EngineRuntime,
  run: RunRow,
  execution: ExecutionRow,
  where: { readonly worktreeId: number; readonly worktreePath: string; readonly surfaceId: number },
): { readonly context: OperationContext; readonly close: () => void } {
  const bridge = rt.bridge.open(
    'This operation context is closed: its node function has already returned.',
  );

  const record = (
    fields: Pick<
      OperationRow,
      'kind' | 'agentSessionId' | 'paneId' | 'harness' | 'model' | 'effort'
    >,
    request: unknown,
  ) =>
    rt
      .commit('workflow_operation_started', (db, emit) =>
        // A node function that keeps running after Cancel may not start anything new.
        getRun(db, run.id)?.status === 'cancelled'
          ? null
          : insertOperation(db, emit, {
              runId: run.id,
              executionId: execution.id,
              ...fields,
              requestJson: toJson(request),
            }),
      )
      .pipe(
        Effect.flatMap((operation) =>
          operation
            ? Effect.succeed(operation)
            : Effect.fail(
                new WorkflowOperationFailed({ message: `Workflow run ${run.id} was cancelled.` }),
              ),
        ),
      );

  /** Runs one effect under its operation row: completed with its result, or failed and rethrown. */
  const logged = <A, E>(
    operation: OperationRow,
    effect: Effect.Effect<A, E>,
    settle: (value: A) => Partial<Pick<OperationRow, 'resultJson' | 'harnessSessionId'>>,
  ) =>
    effect.pipe(
      // `tapError` before `tap`, as `tapBoth` did: a failed completion write is not re-recorded as
      // the operation failing.
      Effect.tapError((cause) =>
        rt.commit('workflow_operation_failed', (db, emit) =>
          settleOperation(db, emit, operation.id, 'failed', {
            resultJson: toJson({ error: errorMessage(cause) }),
          }),
        ),
      ),
      Effect.tap((value) =>
        rt.commit('workflow_operation_completed', (db, emit) =>
          settleOperation(db, emit, operation.id, 'completed', settle(value)),
        ),
      ),
    );

  const context: OperationContext = {
    destination: where,
    execution: {
      runId: run.id,
      graphInvocationId: execution.invocationId,
      executionId: execution.id,
      attempt: execution.retryOf === null ? 'initial' : 'retry',
    },

    spawnAgentSession: (input) =>
      bridge.run(
        Effect.gen(function* () {
          const prompt = yield* render(input.harness, input, 'spawn_agent_session');
          const operation = yield* record(
            {
              kind: 'spawn_agent',
              agentSessionId: null,
              paneId: null,
              harness: input.harness,
              model: input.model ?? null,
              effort: input.effort ?? null,
            },
            requestOf(input, prompt),
          );
          const spawned = yield* logged(
            operation,
            rt.deps.agents.spawn({
              worktreeId: where.worktreeId,
              surfaceId: where.surfaceId,
              harness: input.harness,
              model: input.model,
              effort: input.effort,
              prompt,
              onCreated: (created) =>
                rt.commit('workflow_operation_session', (db) =>
                  updateOperation(db, operation.id, created),
                ),
            }),
            (value) => ({
              resultJson: toJson({
                agentSessionId: value.agentSessionId,
                paneId: value.paneId,
                sentAt: value.sentAt,
              }),
              harnessSessionId: value.harnessSessionId,
            }),
          );
          return {
            agentSessionId: spawned.agentSessionId,
            paneId: spawned.paneId,
            sentAt: spawned.sentAt,
          };
        }),
      ),

    sendAgentPrompt: (input) =>
      bridge.run(
        Effect.gen(function* () {
          const harness = yield* rt.deps.agents.harnessOf(input.agentSessionId);
          const prompt = yield* render(harness, input, 'send_agent_prompt');
          const operation = yield* record(
            {
              kind: 'send_prompt',
              agentSessionId: input.agentSessionId,
              paneId: null,
              harness,
              model: null,
              effort: null,
            },
            requestOf(input, prompt),
          );
          const sent = yield* logged(
            operation,
            rt.deps.agents.send({ agentSessionId: input.agentSessionId, prompt }),
            (value) => ({
              resultJson: toJson({ agentSessionId: input.agentSessionId, sentAt: value.sentAt }),
            }),
          );
          return { agentSessionId: input.agentSessionId, sentAt: sent.sentAt };
        }),
      ),

    closePane: (paneId) =>
      bridge.run(
        Effect.gen(function* () {
          const operation = yield* record(
            {
              kind: 'close_pane',
              agentSessionId: null,
              paneId,
              harness: null,
              model: null,
              effort: null,
            },
            { paneId },
          );
          yield* logged(
            operation,
            rt.deps.agents.closePane({ surfaceId: where.surfaceId, paneId }),
            () => ({}),
          );
        }),
      ),

    getConversationHistory: (agentSessionId) =>
      bridge.run(rt.deps.agents.conversation(agentSessionId)),

    runHeadlessAgent: (input) =>
      bridge.run(
        Effect.gen(function* () {
          const prompt = yield* render(input.harness, input, 'run_headless_agent');
          const operation = yield* record(
            {
              kind: 'run_headless',
              agentSessionId: null,
              paneId: null,
              harness: input.harness,
              model: input.model ?? null,
              effort: input.effort ?? null,
            },
            { ...requestOf(input, prompt), timeoutMs: input.timeoutMs ?? null },
          );
          yield* startHeadless(rt, {
            runId: run.id,
            operationId: operation.id,
            cwd: where.worktreePath,
            harness: input.harness,
            prompt,
            model: input.model,
            effort: input.effort,
            timeoutMs: input.timeoutMs,
          }).pipe(
            Effect.tapError((cause) =>
              rt.commit('workflow_operation_failed', (db, emit) =>
                settleOperation(db, emit, operation.id, 'failed', {
                  resultJson: toJson({ error: errorMessage(cause) }),
                }),
              ),
            ),
          );
          return { operationId: String(operation.id) };
        }),
      ),

    log: (level, message) =>
      bridge
        .run(
          rt.commit('workflow_log', (_db, emit) =>
            emit({
              runId: run.id,
              executionId: execution.id,
              category: 'log',
              kind: 'log',
              message,
              data: { level, message },
            }),
          ),
        )
        .then(() => undefined),

    setUiFeedback: (feedback: WorkflowUiFeedback) =>
      bridge.run(
        rt.commit('workflow_ui_feedback', (db, emit) =>
          emit({
            runId: run.id,
            executionId: execution.id,
            category: 'ui',
            kind: 'ui_feedback',
            message: feedback.message ?? '',
            data: {
              kind: feedback.kind ?? 'info',
              ...(feedback.phase === undefined ? {} : { phase: feedback.phase }),
              ...(feedback.message === undefined ? {} : { message: feedback.message }),
            },
          }),
        ),
      ),
  };

  return { context, close: bridge.close };
}

function render(
  harness: WorkflowAgentHarness,
  input: WorkflowPromptInput,
  operation: WorkflowPromptOperation,
) {
  return renderWorkflowPromptEffect({ harness, promptInput: input, operation });
}

/** What was asked for: the rendered prompt as sent, and the author's own input beside it. */
function requestOf(
  input: WorkflowPromptInput & {
    readonly harness?: WorkflowAgentHarness | undefined;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
    readonly agentSessionId?: number | undefined;
  },
  prompt: string,
) {
  return {
    prompt,
    ...(input.prompt === undefined ? {} : { authoredPrompt: input.prompt }),
    ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
    ...(input.harness === undefined ? {} : { harness: input.harness }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
  };
}
