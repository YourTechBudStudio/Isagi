import assert from 'node:assert/strict';
import test from 'node:test';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  suspend,
  wait,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import type { WorkflowOperationRecord } from '../persistence/records.js';
import { run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import type { WorkflowObservedTurnEdge } from '../waits/conditions.js';
import { makeEngineHarness, type EngineHarness } from './test-support.js';

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

function turnTimes(record: WorkflowOperationRecord) {
  const start = new Date(Date.parse(record.submissionWatermark!) + 1).toISOString();
  const end = new Date(Date.parse(start) + 1).toISOString();
  const laterStart = new Date(Date.parse(end) + 1).toISOString();
  const laterEnd = new Date(Date.parse(laterStart) + 1).toISOString();
  return { start, end, laterStart, laterEnd };
}

function edgeSet(input: {
  readonly start: string;
  readonly end: string;
  readonly laterStart?: string;
  readonly laterEnd?: string;
  readonly firstFailed?: boolean;
}): WorkflowObservedTurnEdge[] {
  return [
    {
      type: 'turn_started',
      agentSessionId: 500,
      harnessSessionId: 'native-session',
      seq: 1,
      recordedAt: input.start,
    },
    input.firstFailed
      ? {
          type: 'turn_failed',
          agentSessionId: 500,
          harnessSessionId: 'native-session',
          seq: 1,
          recordedAt: input.end,
          reason: 'provider_error',
        }
      : {
          type: 'turn_ended',
          agentSessionId: 500,
          harnessSessionId: 'native-session',
          seq: 1,
          recordedAt: input.end,
        },
    ...(input.laterStart && input.laterEnd
      ? ([
          {
            type: 'turn_started',
            agentSessionId: 500,
            harnessSessionId: 'native-session',
            seq: 2,
            recordedAt: input.laterStart,
          },
          {
            type: 'turn_ended',
            agentSessionId: 500,
            harnessSessionId: 'native-session',
            seq: 2,
            recordedAt: input.laterEnd,
          },
        ] satisfies WorkflowObservedTurnEdge[])
      : []),
  ];
}

test('Retry binds a failed response read to the latest exact completed turn', async () => {
  await withHarness(async (harness) => {
    let failRead = true;
    const graph = createGraph<
      { readonly response: string | null },
      {},
      { readonly response: string | null }
    >({
      key: 'response-recovery',
      title: 'Response recovery',
      init: () => ({ response: null }),
      state: { response: reduce.replace<string | null>() },
      entry: 'prompt',
      nodes: {
        prompt: operation(async (ctx) => {
          const target = await ctx.sendAgentPrompt({ agentSessionId: 500, prompt: 'work' });
          return suspend({ wait: wait.agentTurn(target) });
        }),
        read: operation(async (ctx) => {
          const history = await ctx.getConversationHistory(500);
          if (failRead) throw new Error('simulated response parser failure');
          const response = history
            .filter((message) => message.role === 'assistant')
            .flatMap((message) => message.parts)
            .map((part) => part.text)
            .join('');
          return complete({ update: { response } });
        }),
      },
      edges: {
        'prompt-out': edge({ from: 'prompt', to: ['read'], choose: () => ({ to: 'read' }) }),
        'read-out': edge({ from: 'read', to: ['done'], choose: () => ({ to: 'done' }) }),
      },
      outcomes: {
        done: outcome({ kind: 'success', output: (state) => ({ response: state.response }) }),
      },
    });
    harness.publish({
      workflowKey: 'response-recovery',
      version: '1',
      definition: defineWorkflow({
        command: () => ({ title: 'Response recovery' }),
        validate: () => {},
        graph,
      }) as AnyWorkflowDefinition,
    });

    const launched = await harness.launch({ workflowKey: 'response-recovery' });
    await harness.drain();
    const submission = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;
    const times = turnTimes(submission);
    harness.adapters.conversationHistory = [
      { role: 'assistant', parts: [{ type: 'text', text: 'original' }] },
    ];
    harness.adapters.turnEdges.set(500, edgeSet(times));
    assert.equal(await harness.deliver(launched.id), 1);
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'failed');
    assert.deepEqual(harness.adapters.conversationTurns, [null]);

    failRead = false;
    harness.adapters.conversationHistory = [
      { role: 'assistant', parts: [{ type: 'text', text: 'human-guided answer' }] },
    ];
    harness.adapters.turnEdges.set(
      500,
      edgeSet({ ...times, laterStart: times.laterStart, laterEnd: times.laterEnd }),
    );
    assert.equal((await harness.retry(launched.id)).accepted, true);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.deepEqual(harness.adapters.conversationTurns, [
      null,
      {
        harnessSessionId: 'native-session',
        seq: 2,
        startedAt: times.laterStart,
        completedAt: times.laterEnd,
      },
    ]);
  });
});

test('Retry routes on a newer turn event without resending the prompt', async () => {
  await withHarness(async (harness) => {
    const graph = createGraph<
      { readonly outcome: string | null },
      {},
      { readonly outcome: string }
    >({
      key: 'event-recovery',
      title: 'Event recovery',
      init: () => ({ outcome: null }),
      state: { outcome: reduce.replace<string | null>() },
      entry: 'prompt',
      nodes: {
        prompt: operation(async (ctx) => {
          const target = await ctx.sendAgentPrompt({ agentSessionId: 500, prompt: 'work' });
          return suspend({ wait: wait.agentTurn(target) });
        }),
      },
      edges: {
        'prompt-out': edge({
          from: 'prompt',
          to: ['done'],
          choose: (_state, event) => {
            if (event.kind !== 'agent_turn' || event.outcome !== 'ended') {
              throw new Error('the original turn did not complete');
            }
            return { to: 'done', update: { outcome: event.outcome } };
          },
        }),
      },
      outcomes: {
        done: outcome({ kind: 'success', output: (state) => ({ outcome: state.outcome! }) }),
      },
    });
    harness.publish({
      workflowKey: 'event-recovery',
      version: '1',
      definition: defineWorkflow({
        command: () => ({ title: 'Event recovery' }),
        validate: () => {},
        graph,
      }) as AnyWorkflowDefinition,
    });

    const launched = await harness.launch({ workflowKey: 'event-recovery' });
    await harness.drain();
    const submission = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;
    const times = turnTimes(submission);
    harness.adapters.turnEdges.set(500, edgeSet({ ...times, firstFailed: true }));
    assert.equal(await harness.deliver(launched.id), 1);
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'failed');

    harness.adapters.turnEdges.set(
      500,
      edgeSet({
        ...times,
        firstFailed: true,
        laterStart: times.laterStart,
        laterEnd: times.laterEnd,
      }),
    );
    assert.equal((await harness.retry(launched.id)).accepted, true);
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'done');
    assert.equal(harness.adapters.counters.promptWrites, 1);
  });
});

test('a refresh failure leaves a failed run byte-identical', async () => {
  await withHarness(async (harness) => {
    let fail = true;
    const graph = createGraph<{ readonly value: number }, {}, { readonly value: number }>({
      key: 'refresh-failure',
      title: 'Refresh failure',
      init: () => ({ value: 0 }),
      state: { value: reduce.replace<number>() },
      entry: 'prompt',
      nodes: {
        prompt: operation(async (ctx) => {
          const target = await ctx.sendAgentPrompt({ agentSessionId: 500, prompt: 'work' });
          return suspend({ wait: wait.agentTurn(target) });
        }),
      },
      edges: {
        'prompt-out': edge({
          from: 'prompt',
          to: ['done'],
          choose: () => {
            if (fail) throw new Error('routing fails');
            return { to: 'done', update: { value: 1 } };
          },
        }),
      },
      outcomes: { done: outcome({ kind: 'success', output: (state) => ({ value: state.value }) }) },
    });
    harness.publish({
      workflowKey: 'refresh-failure',
      version: '1',
      definition: defineWorkflow({
        command: () => ({ title: 'Refresh failure' }),
        validate: () => {},
        graph,
      }) as AnyWorkflowDefinition,
    });
    const launched = await harness.launch({ workflowKey: 'refresh-failure' });
    await harness.drain();
    const submission = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;
    const times = turnTimes(submission);
    harness.adapters.turnEdges.set(500, edgeSet(times));
    await harness.deliver(launched.id);
    await harness.drain();
    const before = await harness.runOf(launched.id);
    assert.equal(before.status, 'failed');

    fail = false;
    harness.adapters.failures.set('turnEdges', new Error('native artifact unreadable'));
    const result = await Effect.runPromiseExit(harness.controls.retry(launched.id));
    assert.equal(result._tag, 'Failure');
    assert.deepEqual(await harness.runOf(launched.id), before);
  });
});
