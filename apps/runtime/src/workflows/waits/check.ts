import { Effect } from 'effect';

import type { EngineRuntime } from '../engine/runtime.js';
import { lastAssistantText } from '../operations/agents.js';
import { settleExitedHeadless } from '../operations/headless.js';
import { getOperation, listOperations } from '../store/operations.js';
import { fromJson, type ExecutionRow, type OperationRow } from '../store/rows.js';
import type {
  AgentTurnTarget,
  HeadlessOperationResult,
  NodeEvent,
  WaitDeclaration,
} from '../types.js';
import { latestTurn } from './latest-turn.js';

/**
 * Whether a suspended execution's wait has been answered, and with what.
 *
 * Checked right after the result is saved (the event may already have happened), whenever a
 * trigger arrives — a turn edge, a headless exit, an `advance` — and on Resume. Nothing here writes;
 * the caller applies the event together with the pure step.
 */
export type WaitCheck =
  | { readonly kind: 'waiting' }
  | {
      readonly kind: 'delivered';
      readonly event: NodeEvent;
      /** The agent's reply to record on the operation that sent the prompt. */
      readonly reply: AgentReply | null;
    };

export interface AgentReply {
  readonly operationId: number;
  /** Null when the reply could not be read; the run continues and a log event says so. */
  readonly responseText: string | null;
  readonly unavailable: string | null;
}

/** The stored result of a headless operation, in `result_json`. */
export interface HeadlessOperationRecord {
  readonly exitCode?: number | null | undefined;
  readonly error?: string | undefined;
  readonly interruption?: HeadlessOperationResult['interruption'];
}

export function checkWait(
  rt: EngineRuntime,
  execution: ExecutionRow,
  wait: WaitDeclaration,
): Effect.Effect<WaitCheck, unknown> {
  switch (wait.kind) {
    case 'user_continue':
    case 'user_input': {
      // Answers arrive through `advance`, which stores them on the execution.
      const stored = fromJson<NodeEvent>(execution.eventJson);
      return Effect.succeed(
        stored ? { kind: 'delivered', event: stored, reply: null } : { kind: 'waiting' },
      );
    }
    case 'headless_agent':
      return settleExitedHeadless(
        rt,
        wait.operations.map((handle) => Number(handle.operationId)),
      ).pipe(
        // A write that fails again leaves the job owned for the next check; the wait keeps waiting.
        Effect.catchAll((cause) =>
          Effect.sync(() =>
            console.warn('[runtime] Settling an exited headless job failed', cause),
          ),
        ),
        Effect.zipRight(
          rt.read('workflow_check_headless', (db) => {
            const rows = wait.operations.map((handle) =>
              getOperation(db, Number(handle.operationId)),
            );
            if (rows.some((row) => row === null || row.status === 'running')) {
              return { kind: 'waiting' } as const;
            }
            return {
              kind: 'delivered',
              event: {
                kind: 'headless_agent',
                results: (rows as OperationRow[]).map(headlessResultOf),
              },
              reply: null,
            } as const;
          }),
        ),
      );
    case 'agent_turn':
      return checkAgentTurn(rt, execution, wait.target);
  }
}

function checkAgentTurn(
  rt: EngineRuntime,
  execution: ExecutionRow,
  target: AgentTurnTarget,
): Effect.Effect<WaitCheck, unknown> {
  return Effect.gen(function* () {
    const agents = rt.deps.agents;
    // Resume and startup refresh first, because the observer may not have caught up with the
    // harness's own records yet. A refresh that fails falls back to what the observer holds.
    const fresh = rt.freshChecks.has(execution.runId);
    const refreshed = fresh
      ? yield* agents.turnEdges(target.agentSessionId, true).pipe(Effect.option)
      : null;
    const edges =
      refreshed?._tag === 'Some'
        ? refreshed.value
        : yield* agents.turnEdges(target.agentSessionId, false);
    const found = latestTurn(target, edges);

    if (found.kind === 'waiting') {
      // With a trusted, fresh observation, a session whose process is gone and whose turn never
      // started will never answer.
      if (refreshed?._tag === 'Some' && !found.started) {
        const alive = yield* agents.isAlive(target.agentSessionId);
        if (!alive) {
          return {
            kind: 'delivered',
            event: {
              kind: 'agent_turn',
              outcome: 'interrupted',
              recordedAt: new Date().toISOString(),
              reason: 'session_died',
            },
            reply: null,
          } satisfies WaitCheck;
        }
      }
      return { kind: 'waiting' } satisfies WaitCheck;
    }

    const operation = yield* rt.read('workflow_find_prompt_operation', (db) =>
      promptOperation(db, execution.runId, target),
    );
    let reply: AgentReply | null = null;
    if (operation && found.event.outcome !== 'interrupted') {
      const turn = found.turn;
      const text = turn
        ? yield* agents.conversation(target.agentSessionId, turn).pipe(
            Effect.map(lastAssistantText),
            Effect.orElseSucceed(() => null),
          )
        : null;
      reply = {
        operationId: operation.id,
        responseText: text,
        unavailable:
          text === null
            ? `The reply of agent session ${target.agentSessionId} to operation ${operation.id} could not be read.`
            : null,
      };
    }
    return { kind: 'delivered', event: found.event, reply } satisfies WaitCheck;
  });
}

/** The spawn or send that produced a turn target: same session, same `sentAt`. */
function promptOperation(
  db: Parameters<Parameters<EngineRuntime['read']>[1]>[0],
  runId: number,
  target: AgentTurnTarget,
): OperationRow | null {
  const candidates = listOperations(db, { runId, agentSessionId: target.agentSessionId });
  return (
    candidates
      .filter((row) => row.kind === 'spawn_agent' || row.kind === 'send_prompt')
      .findLast((row) => fromJson<{ sentAt?: string }>(row.resultJson)?.sentAt === target.sentAt) ??
    null
  );
}

export function headlessResultOf(row: OperationRow): HeadlessOperationResult {
  const record = fromJson<HeadlessOperationRecord>(row.resultJson) ?? {};
  const status = row.status === 'running' ? 'failed' : row.status;
  return {
    operationId: String(row.id),
    status,
    ...(row.responseText === null ? {} : { output: row.responseText }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.interruption === undefined ? {} : { interruption: record.interruption }),
  };
}
