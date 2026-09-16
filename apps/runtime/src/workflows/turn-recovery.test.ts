import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { HarnessConversationTurn } from '../agent-sessions/harness/definition-types.js';
import type { WorkflowCapabilitiesService } from './capabilities.js';
import { workflowContext } from './context.js';
import { completedRecoveryTurn, planAgentTurnRetry, type AgentTurnWait } from './turn-recovery.js';
import type { WorkflowRunRow } from './types.js';
import {
  findSatisfiedTerminalTurnEdge,
  parseResumePayload,
  resumePayload,
  type WorkflowObservedTurnEdge,
} from './wait-conditions.js';

const time = (second: number) => new Date(Date.UTC(2026, 8, 13, 0, 0, second)).toISOString();
const condition: AgentTurnWait = { kind: 'agent_turn', agentSessionId: 142, sentAt: time(0) };
const start = (
  seq: number,
  second: number,
  harnessSessionId = 'session',
): WorkflowObservedTurnEdge => ({
  type: 'turn_started',
  agentSessionId: 142,
  harnessSessionId,
  seq,
  recordedAt: time(second),
});
const end = (
  seq: number,
  second: number,
  failed = false,
  harnessSessionId = 'session',
): WorkflowObservedTurnEdge => ({
  type: failed ? 'turn_failed' : 'turn_ended',
  agentSessionId: 142,
  harnessSessionId,
  seq,
  recordedAt: time(second),
  reason: failed ? 'harness_error' : undefined,
});
const originalEdges = [start(0, 0), end(0, 1, true)];
const failedRun: WorkflowRunRow = {
  id: 62,
  rootRunId: 49,
  parentRunId: 56,
  workflowKey: 'review',
  workflowTitle: 'Review',
  workflowArtifactHash: '0'.repeat(64),
  worktreeId: 9,
  surfaceId: 41,
  status: 'failed',
  controlRevision: 0,
  retrying: false,
  paused: false,
  cancelRequested: false,
  waitKind: null,
  waitCondition: null,
  resumePayload: JSON.stringify(
    resumePayload({ type: 'turn_failed', recordedAt: time(1), reason: 'harness_error' }, condition),
  ),
  stateJson: '{}',
  stateVersion: 1,
  owner: null,
  error: '{}',
  resultJson: null,
  createdAt: time(0),
  updatedAt: time(1),
};

for (const harness of ['claude', 'codex', 'pi', 'opencode']) {
  test(`${harness}: explicit retry accepts a new turn in the same durable agent session`, () => {
    const edges = [
      ...originalEdges,
      start(0, 2, `${harness}-new-session`),
      end(0, 3, false, `${harness}-new-session`),
    ];
    const retry = planAgentTurnRetry(failedRun, edges);
    assert.ok(retry?.payload);
    const recovered = { ...failedRun, resumePayload: JSON.stringify(retry.payload) };
    assert.deepEqual(parseResumePayload(recovered), { outcome: 'ended', recordedAt: time(3) });
    assert.deepEqual(completedRecoveryTurn(recovered), {
      agentSessionId: 142,
      turn: {
        harnessSessionId: `${harness}-new-session`,
        seq: 0,
        startedAt: time(2),
        completedAt: time(3),
      },
    });
    assert.equal(findSatisfiedTerminalTurnEdge(condition, edges)?.type, 'turn_failed');
  });
}

test('retry pins a running latest turn and ignores a later turn while waiting', () => {
  const retry = planAgentTurnRetry(failedRun, [...originalEdges, start(2, 2)]);
  assert.ok(retry);
  assert.equal(retry.payload, null);
  assert.equal(
    findSatisfiedTerminalTurnEdge(retry.condition, [
      ...originalEdges,
      start(2, 2),
      start(3, 3),
      end(3, 4),
    ]),
    null,
  );
  assert.equal(
    findSatisfiedTerminalTurnEdge(retry.condition, [...originalEdges, start(2, 2), end(2, 4)])
      ?.recordedAt,
    time(4),
  );
});

test('latest failure wins over an intervening success', () => {
  const retry = planAgentTurnRetry(failedRun, [
    ...originalEdges,
    start(2, 2),
    end(2, 3),
    start(4, 4),
    end(4, 5, true),
  ]);
  assert.deepEqual(
    parseResumePayload({ ...failedRun, resumePayload: JSON.stringify(retry?.payload) }),
    {
      outcome: 'failed',
      recordedAt: time(5),
      reason: 'harness_error',
    },
  );
});

test('retry never borrows older responses or another durable agent session', () => {
  assert.equal(planAgentTurnRetry(failedRun, originalEdges), null);
  assert.equal(
    planAgentTurnRetry(
      failedRun,
      [start(2, 2), end(2, 3)].map((edge) => ({ ...edge, agentSessionId: 999 })),
    ),
    null,
  );
  assert.equal(
    planAgentTurnRetry(
      {
        ...failedRun,
        resumePayload: JSON.stringify({
          outcome: 'failed',
          recordedAt: time(1),
          reason: 'harness_error',
        }),
      },
      [...originalEdges, start(2, 2), end(2, 3)],
    ),
    null,
  );
  assert.equal(
    planAgentTurnRetry({ ...failedRun, resumePayload: JSON.stringify({ kind: 'user_continue' }) }, [
      ...originalEdges,
      start(2, 2),
      end(2, 3),
    ]),
    null,
  );
});

test('retry can recover a failed response read after a successful completion event', () => {
  const run = {
    ...failedRun,
    resumePayload: JSON.stringify(
      resumePayload({ type: 'turn_ended', recordedAt: time(1) }, condition),
    ),
  };
  assert.ok(planAgentTurnRetry(run, [start(0, 0), end(0, 1), start(2, 2), end(2, 3)])?.payload);
});

test('a failed response read can reread its completed turn but cannot move back to an older completion', () => {
  const run = {
    ...failedRun,
    resumePayload: JSON.stringify(
      resumePayload({ type: 'turn_ended', recordedAt: time(3) }, condition),
    ),
  };
  const retry = planAgentTurnRetry(run, [start(0, 0), end(0, 3)]);
  assert.ok(retry?.payload);
  assert.equal(retry.payload.recordedAt, time(3));
  assert.equal(planAgentTurnRetry(run, [start(0, 0), end(0, 1)]), null);
  assert.equal(planAgentTurnRetry(run, [start(0, 0)]), null);
});

test('resumed context pins and memoizes the final response to the same turn as its event', async () => {
  const retry = planAgentTurnRetry(failedRun, [...originalEdges, start(2, 2), end(2, 3)]);
  assert.ok(retry?.payload);
  // JSON roundtrip represents restoration; selection does not live in an engine closure.
  const run = JSON.parse(
    JSON.stringify({ ...failedRun, retrying: true, resumePayload: JSON.stringify(retry.payload) }),
  ) as WorkflowRunRow;
  const reads: { id: number; turn: HarnessConversationTurn | undefined }[] = [];
  const capabilities: WorkflowCapabilitiesService = {
    getConversationHistory: (id, turn) =>
      Effect.sync(() => {
        reads.push({ id, turn });
        return [
          {
            role: 'assistant',
            parts: [{ type: 'text', text: turn ? 'selected response' : 'latest response' }],
          },
        ];
      }),
    spawnAgentSessionForRun: () => Effect.die('unexpected spawn'),
    sendAgentPrompt: () => Effect.die('unexpected send'),
    closePaneForRun: () => Effect.die('unexpected close'),
    runHeadlessAgentForRun: () => Effect.die('unexpected headless'),
    appendWorkflowLog: () => Effect.void,
    setWorkflowUiFeedback: () => Effect.void,
  };
  const ctx = workflowContext({ capabilities, run, worktreePath: '/worktree' });
  const first = await ctx.getConversationHistory(142);
  assert.equal(await ctx.getConversationHistory(142), first);
  await ctx.getConversationHistory(999);
  assert.deepEqual(reads, [
    {
      id: 142,
      turn: { harnessSessionId: 'session', seq: 2, startedAt: time(2), completedAt: time(3) },
    },
    { id: 999, turn: undefined },
  ]);
  assert.deepEqual(parseResumePayload(run), { outcome: 'ended', recordedAt: time(3) });
});
