import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { makeFakeFluidcastSessions } from '../../../fluidcast/testing.js';
import { HarnessLedgerObserver } from '../../../harnesses/index.js';
import { pollHarnessLedgerObserverForTest } from '../../../harnesses/testing.js';
import { InternalEvents } from '../../../platform/events/index.js';
import { tapInternalEvents } from '../../../platform/events/testing.js';
import { RuntimeDatabase } from '../../../platform/persistence/index.js';
import { ptyProcesses } from '../../../pty-processes/tables.js';
import { agentSessions } from '../../tables.js';
import { AgentSessionInteraction } from '../interaction.js';
import {
  edgeSummary,
  hookRecord,
  prepareAgent,
  ptyMark,
  rolloutLines,
  sdkExecutionMark,
  seedActiveAgentSession,
  seedFluidcastMode,
  seedRuntimeDatabase,
  testLayer,
} from './test-support.js';

// Observation under SDK control through the environment's real targets layer: the Fluidcast
// overlay over a database whose PTY pointer still names the terminal the switch stopped. Record
// times start after the fake session's `since`, so they fall inside its interval.

const sdkMark = sdkExecutionMark('fc-1');

/** Stops the seeded PTY 20, as the switch to Fluidcast does, leaving the pointer on it. */
const stopSeededPty = (root: string) =>
  seedRuntimeDatabase(root, (db) => {
    db.update(ptyProcesses).set({ status: 'killed', statusReason: 'user_requested' }).run();
  });

test('polling observes a Fluidcast-mode agent whose stale PTY has stopped, and a fault fails its open turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-fluidcast-health-'));
  try {
    await seedActiveAgentSession(root, 'claude');
    await stopSeededPty(root);
    const ledger = prepareAgent(root, 'claude-session');
    const fluidcast = makeFakeFluidcastSessions();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalEvents;
        const changes = yield* tapInternalEvents(['agent_session_changed']);
        yield* seedFluidcastMode(fluidcast, {
          agentSessionId: 10,
          harness: 'claude',
          harnessSessionId: 'claude-session',
        });
        yield* changes.take;
        const origin = Date.now() + 1_000;
        appendFileSync(
          ledger,
          hookRecord('claude', 'claude-session', 'UserPromptSubmit', 1, sdkMark, {}, 10, origin),
        );
        // The global pass: the live inventory includes the agent although its PTY is killed.
        yield* pollHarnessLedgerObserverForTest();
        yield* changes.take;
        const whileSdkRuns = yield* observer.getAttention(10);

        fluidcast.fault(fluidcast.live()[0]!, 'worker_exited');
        yield* bus.publish({
          type: 'agent_session_execution_changed',
          agentSessionId: 10,
          change: { _tag: 'health' },
        });
        yield* changes.take;
        return {
          whileSdkRuns,
          afterFault: yield* observer.getAttention(10),
          edges: yield* observer.getTurnEdges(10),
        };
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { fluidcast }))),
    );
    assert.equal(result.whileSdkRuns, 'working');
    assert.equal(result.afterFault, 'error');
    assert.deepEqual(edgeSummary(result.edges), [
      ['turn_started', 0, null],
      ['turn_failed', 0, 'session_died'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an open SDK turn dies on the switch back to terminal, and a late SDK record is not current', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-fluidcast-switch-'));
  try {
    await seedActiveAgentSession(root, 'claude');
    await stopSeededPty(root);
    const ledger = prepareAgent(root, 'claude-session');
    const fluidcast = makeFakeFluidcastSessions();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalEvents;
        const interaction = yield* AgentSessionInteraction;
        const database = yield* RuntimeDatabase;
        const changes = yield* tapInternalEvents(['agent_session_changed']);
        const started = yield* seedFluidcastMode(fluidcast, {
          agentSessionId: 10,
          harness: 'claude',
          harnessSessionId: 'claude-session',
        });
        yield* changes.take;
        const origin = Date.now() + 1_000;
        appendFileSync(
          ledger,
          hookRecord(
            'claude',
            'claude-session',
            'UserPromptSubmit',
            1,
            sdkMark,
            {
              prompt_id: 'sdk-prompt',
            },
            10,
            origin,
          ),
        );
        yield* pollHarnessLedgerObserverForTest(10);
        yield* changes.take;

        // Back to terminal, as the switch does it: the session ends, then a new PTY launches.
        interaction.delete(10);
        yield* fluidcast.service.stop(started.fluidcastSessionId);
        const since = new Date(origin + 5_000).toISOString();
        yield* database.use('test_relaunch_pty', (db) => {
          db.insert(ptyProcesses)
            .values({
              id: 21,
              backend: 'node_pty',
              backendRefJson: '{}',
              command: 'claude',
              argsJson: '[]',
              cwd: '/repo/isagi',
              status: 'running',
              statusReason: null,
              exitCode: null,
              signal: null,
              logMode: 'none',
              logPath: null,
              createdAt: since,
              updatedAt: since,
              exitedAt: null,
              lastSeenAt: null,
            })
            .run();
          db.update(agentSessions)
            .set({ activePtyProcessId: 21 })
            .where(eq(agentSessions.id, 10))
            .run();
        });
        yield* bus.publish({
          type: 'agent_session_execution_changed',
          agentSessionId: 10,
          change: { _tag: 'switched', interval: { incarnation: 'pty:21', since } },
        });
        yield* changes.take;
        const afterSwitch = yield* observer.getAttention(10);

        // The ended worker's late Stop belongs to the SDK execution, not to the running PTY.
        appendFileSync(
          ledger,
          hookRecord(
            'claude',
            'claude-session',
            'Stop',
            7,
            sdkMark,
            {
              prompt_id: 'sdk-prompt',
              background_tasks: [],
            },
            10,
            origin,
          ),
        );
        yield* pollHarnessLedgerObserverForTest(10);
        return {
          afterSwitch,
          afterLate: yield* observer.getAttention(10),
          edges: yield* observer.getTurnEdges(10),
        };
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { fluidcast }))),
    );
    assert.equal(result.afterSwitch, 'error');
    assert.deepEqual(edgeSummary(result.edges), [
      ['turn_started', 0, null],
      ['turn_failed', 0, 'session_died'],
    ]);
    // The PTY is running and idle; the dead SDK turn's late record changed nothing.
    assert.equal(result.afterLate, result.afterSwitch);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed SDK turn without a fault leaves the execution live', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-fluidcast-turn-failed-'));
  try {
    await seedActiveAgentSession(root, 'claude');
    await stopSeededPty(root);
    const ledger = prepareAgent(root, 'claude-session');
    const fluidcast = makeFakeFluidcastSessions();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const changes = yield* tapInternalEvents(['agent_session_changed']);
        yield* seedFluidcastMode(fluidcast, {
          agentSessionId: 10,
          harness: 'claude',
          harnessSessionId: 'claude-session',
        });
        yield* changes.take;
        const origin = Date.now() + 1_000;
        for (const [nativeEvent, seconds, promptId] of [
          ['UserPromptSubmit', 1, 'first'],
          ['StopFailure', 2, 'first'],
          ['UserPromptSubmit', 3, 'second'],
        ] as const)
          appendFileSync(
            ledger,
            hookRecord(
              'claude',
              'claude-session',
              nativeEvent,
              seconds,
              sdkMark,
              {
                prompt_id: promptId,
              },
              10,
              origin,
            ),
          );
        yield* pollHarnessLedgerObserverForTest(10);
        return {
          attention: yield* observer.getAttention(10),
          edges: yield* observer.getTurnEdges(10),
        };
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { fluidcast }))),
    );
    assert.equal(result.attention, 'working');
    assert.deepEqual(edgeSummary(result.edges), [
      ['turn_started', 0, null],
      ['turn_failed', 0, 'harness_error'],
      ['turn_started', 2, null],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex under Fluidcast control promotes its thread from the SDK incarnation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-fluidcast-codex-'));
  try {
    await seedActiveAgentSession(root, 'codex');
    await stopSeededPty(root);
    const rollout = join(root, 'sdk-rollout.jsonl');
    const ledger = prepareAgent(root, 'sdk-thread', null);
    const fluidcast = makeFakeFluidcastSessions();
    const attention = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const changes = yield* tapInternalEvents(['agent_session_changed']);
        yield* seedFluidcastMode(fluidcast, {
          agentSessionId: 10,
          harness: 'codex',
          harnessSessionId: null,
        });
        yield* changes.take;
        const origin = Date.now() + 1_000;
        writeFileSync(
          rollout,
          rolloutLines(
            [
              ['session_meta', 1.5, { id: 'sdk-thread' }],
              ['event_msg', 2, { type: 'task_started', turn_id: 'turn-1' }],
            ],
            origin,
          ),
        );
        // A stale PTY-marked SessionStart for another thread is not a candidate.
        appendFileSync(
          ledger,
          hookRecord(
            'codex',
            'pty-thread',
            'SessionStart',
            0.5,
            ptyMark(20),
            {
              session_id: 'pty-thread',
            },
            10,
            origin,
          ),
        );
        appendFileSync(
          ledger,
          hookRecord(
            'codex',
            'sdk-thread',
            'SessionStart',
            1,
            sdkMark,
            {
              session_id: 'sdk-thread',
              transcript_path: rollout,
            },
            10,
            origin,
          ),
        );
        yield* pollHarnessLedgerObserverForTest(10);
        return yield* observer.getAttention(10);
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { fluidcast }))),
    );
    assert.equal(attention, 'working');
    const metadata = JSON.parse(
      readFileSync(join(root, 'sessions', 'agent-sessions', '10', 'harness.json'), 'utf8'),
    ) as { readonly harnessSessionId: string | null };
    assert.equal(metadata.harnessSessionId, 'sdk-thread');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
