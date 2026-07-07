import { Effect } from 'effect';

import type { WorkflowVariables } from '@isagi/workflow-sdk';

import type { WorkflowCapabilitiesService } from './capabilities.js';
import type { WorkflowContext, WorkflowRunRow } from './types.js';

export function workflowContext(input: {
  readonly capabilities: WorkflowCapabilitiesService;
  readonly run: WorkflowRunRow;
  readonly worktreePath: string;
  readonly startWorkflow?: (input: {
    readonly parentRun: WorkflowRunRow;
    readonly workflowKey: string;
    readonly variables: WorkflowVariables;
    readonly context?: {
      readonly surfaceId?: number | undefined;
      readonly agentSessionId?: number | null | undefined;
    };
  }) => Effect.Effect<WorkflowRunRow, unknown, never>;
}): WorkflowContext {
  // Workflow callbacks are plain async TypeScript (the engine runs the whole step
  // inside `Effect.tryPromise`), so every `ctx` verb must cross the Effect->Promise
  // boundary here. Capability failures surface as rejected Promises the engine turns
  // into failed runs. The deliberate v1 tradeoff is cancellation: `runPromise` starts
  // a detached root fiber, so a long `spawnAgentSession` poll or pending
  // `sendAgentPrompt` is NOT interrupted when the engine scope closes on shutdown.
  // That is acceptable here — the runtime owns these PTY/session resources
  // regardless, the gate runs at concurrency 1, and a JS Promise is not interruptible
  // by Effect anyway. Revisit if verbs need to abort cleanly on shutdown.
  const runEffect = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect);

  return {
    worktreePath: input.worktreePath,
    spawnAgentSession: (session) =>
      runEffect(
        input.capabilities.spawnAgentSessionForRun({
          run: input.run,
          input: session,
        }),
      ),
    sendAgentPrompt: (agentSessionId, text) =>
      runEffect(
        input.capabilities.sendAgentPrompt({
          agentSessionId,
          text,
        }),
      ),
    closePane: (paneId) =>
      runEffect(
        input.capabilities.closePaneForRun({
          run: input.run,
          paneId,
        }),
      ),
    getConversationHistory: (target) =>
      runEffect(input.capabilities.getConversationHistory(target)),
    getHarnessSessionId: (agentSessionId) =>
      runEffect(input.capabilities.getHarnessSessionId(agentSessionId)),
    runHeadlessAgent: (prompt) =>
      runEffect(
        input.capabilities.runHeadlessAgentForRun({
          run: input.run,
          worktreePath: input.worktreePath,
          input: prompt,
        }),
      ),
    startWorkflow: (workflowKey, variables = {}, context) =>
      runEffect(
        (
          input.startWorkflow ??
          (() => Effect.die('workflow startWorkflow is not available in this context'))
        )(
          context === undefined
            ? {
                parentRun: input.run,
                workflowKey,
                variables,
              }
            : {
                parentRun: input.run,
                workflowKey,
                variables,
                context,
              },
        ),
      ).then((run) => run.id),
    log: (level, message) =>
      runEffect(
        input.capabilities.appendWorkflowLog({
          run: input.run,
          level,
          message,
        }),
      ).then(() => undefined),
    setUiFeedback: (feedback) =>
      runEffect(
        input.capabilities.setWorkflowUiFeedback({
          run: input.run,
          feedback,
        }),
      ).then(() => undefined),
  };
}
