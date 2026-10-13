import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import {
  HarnessLedgerObserver,
  HarnessObservationTargets,
  type ActiveExecution,
  type HarnessObservationTarget,
  type Incarnation,
} from '../../../harnesses/index.js';
import { pollHarnessLedgerObserverForTest } from '../../../harnesses/testing.js';
import { InternalEvents } from '../../../platform/events/index.js';
import { tapInternalEvents } from '../../../platform/events/testing.js';
import {
  at,
  edgeSummary,
  hookRecord,
  prepareAgent,
  ptyMark,
  rolloutLines,
  sdkExecutionMark,
  seedActiveAgentSession,
  testLayer,
} from './test-support.js';

// Observation of an execution-keyed agent. Targets come from a stub, because nothing in the
// environment can report an SDK execution yet; every timestamp is relative to the `since` values
// the stub and the switch events carry, so each case exercises the interval rule it names.

test('background polling observes an SDK execution, and its open turn dies on a switch to a PTY', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-sdk-switch-'));
  try {
    const ledger = prepareAgent(root, 'claude-session');
    const targets = stubTargets([target(10, 'claude', sdk('execution-1', 0))]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalEvents;
        const changes = yield* tapInternalEvents(['agent_session_changed']);

        appendFileSync(
          ledger,
          hookRecord('claude', 'claude-session', 'UserPromptSubmit', 1, sdkMark),
        );
        // The global pass, not a per-agent poll: the live inventory includes the SDK execution.
        yield* pollHarnessLedgerObserverForTest();
        yield* changes.take;
        const whileSdkRuns = yield* observer.getAttention(10);

        targets.set([target(10, 'claude', pty(21, 5))]);
        yield* bus.publish(switched(10, 'pty:21', 5));
        yield* changes.take;
        return {
          whileSdkRuns,
          afterSwitch: yield* observer.getAttention(10),
          edges: yield* observer.getTurnEdges(10),
        };
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { targets: targets.layer }))),
    );
    assert.equal(result.whileSdkRuns, 'working');
    assert.equal(result.afterSwitch, 'error');
    assert.deepEqual(edgeSummary(result.edges), [
      ['turn_started', 0, null],
      ['turn_failed', 0, 'session_died'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a worker fault reported as health fails the open SDK turn without a new interval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-sdk-health-'));
  try {
    const ledger = prepareAgent(root, 'claude-session');
    const targets = stubTargets([target(10, 'claude', sdk('execution-1', 0))]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalEvents;
        const changes = yield* tapInternalEvents(['agent_session_changed']);
        appendFileSync(
          ledger,
          hookRecord('claude', 'claude-session', 'UserPromptSubmit', 1, sdkMark),
        );
        yield* pollHarnessLedgerObserverForTest(10);
        yield* changes.take;

        targets.set([target(10, 'claude', sdk('execution-1', 0, false))]);
        yield* bus.publish({
          type: 'agent_session_execution_changed',
          agentSessionId: 10,
          change: { _tag: 'health' },
        });
        yield* changes.take;
        return {
          attention: yield* observer.getAttention(10),
          edges: yield* observer.getTurnEdges(10),
        };
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { targets: targets.layer }))),
    );
    assert.equal(result.attention, 'error');
    assert.deepEqual(edgeSummary(result.edges), [
      ['turn_started', 0, null],
      ['turn_failed', 0, 'session_died'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a late SDK record after a PTY relaunch cannot pose as the current execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-sdk-late-'));
  try {
    const ledger = prepareAgent(root, 'claude-session');
    const targets = stubTargets([target(10, 'claude', sdk('execution-1', 0))]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalEvents;
        const changes = yield* tapInternalEvents(['agent_session_changed']);
        appendFileSync(
          ledger,
          hookRecord('claude', 'claude-session', 'UserPromptSubmit', 1, sdkMark, {
            prompt_id: 'sdk-prompt',
          }),
        );
        yield* pollHarnessLedgerObserverForTest(10);
        yield* changes.take;

        targets.set([target(10, 'claude', pty(21, 5))]);
        yield* bus.publish(switched(10, 'pty:21', 5));
        yield* changes.take;
        appendFileSync(
          ledger,
          hookRecord('claude', 'claude-session', 'UserPromptSubmit', 6, ptyMark(21), {
            prompt_id: 'pty-prompt',
          }),
        );
        yield* pollHarnessLedgerObserverForTest(10);
        yield* changes.take;

        // The stopped worker's Stop lands after the PTY took over.
        appendFileSync(
          ledger,
          hookRecord('claude', 'claude-session', 'Stop', 7, sdkMark, {
            prompt_id: 'sdk-prompt',
            background_tasks: [],
          }),
        );
        yield* pollHarnessLedgerObserverForTest(10);
        return {
          attention: yield* observer.getAttention(10),
          edges: yield* observer.getTurnEdges(10),
        };
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { targets: targets.layer }))),
    );
    assert.equal(result.attention, 'working');
    assert.deepEqual(edgeSummary(result.edges), [
      ['turn_started', 0, null],
      ['turn_failed', 0, 'session_died'],
      ['turn_started', 1, null],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex under SDK control promotes its thread from the SDK incarnation and dies with the worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-sdk-codex-'));
  try {
    const rollout = join(root, 'sdk-rollout.jsonl');
    const ledger = prepareAgent(root, 'sdk-thread', null);
    const targets = stubTargets([target(10, 'codex', sdk('execution-1', 0))]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalEvents;
        const changes = yield* tapInternalEvents(['agent_session_changed']);
        writeFileSync(
          rollout,
          rolloutLines([
            ['session_meta', 1.5, { id: 'sdk-thread' }],
            ['event_msg', 2, { type: 'task_started', turn_id: 'turn-1' }],
          ]),
        );
        appendFileSync(
          ledger,
          hookRecord('codex', 'sdk-thread', 'SessionStart', 1, sdkMark, {
            session_id: 'sdk-thread',
            transcript_path: rollout,
          }),
        );
        yield* pollHarnessLedgerObserverForTest(10);
        yield* changes.take;
        const whileSdkRuns = yield* observer.getAttention(10);

        targets.set([target(10, 'codex', sdk('execution-1', 0, false))]);
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
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { targets: targets.layer }))),
    );
    assert.equal(result.whileSdkRuns, 'working');
    assert.equal(readMetadata(root, 10).harnessSessionId, 'sdk-thread');
    assert.equal(result.afterFault, 'error');
    assert.deepEqual(edgeSummary(result.edges), [
      ['turn_started', 1, null],
      ['turn_failed', 1, 'session_died'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a quick double switch records the middle interval from its event payload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-double-switch-'));
  try {
    const rollout = join(root, 'sdk-rollout.jsonl');
    const ledger = prepareAgent(root, 'sdk-thread');
    const targets = stubTargets([target(10, 'codex', pty(20, 0))]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalEvents;
        const changes = yield* tapInternalEvents(['agent_session_changed']);
        // The SDK execution started the thread and opened a turn, then the agent went straight
        // back to a PTY. State is read only after both switches.
        appendFileSync(
          ledger,
          hookRecord(
            'codex',
            'sdk-thread',
            'SessionStart',
            10.2,
            { pty: null, sdk: 'a' },
            {
              session_id: 'sdk-thread',
              transcript_path: rollout,
            },
          ),
        );
        writeFileSync(
          rollout,
          rolloutLines([
            ['session_meta', 10.3, { id: 'sdk-thread' }],
            ['event_msg', 10.5, { type: 'task_started', turn_id: 'turn-1' }],
          ]),
        );
        targets.set([target(10, 'codex', pty(21, 11))]);
        yield* bus.publish(switched(10, 'sdk:a', 10));
        yield* bus.publish(switched(10, 'pty:21', 11));
        yield* changes.take;
        yield* changes.take;
        yield* pollHarnessLedgerObserverForTest(10);
        return yield* observer.getTurnEdges(10);
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { targets: targets.layer }))),
    );
    // Without the `sdk:a` interval the turn would fall in `pty:20`'s, which never started this
    // thread, and stay unattributed instead of failing with the execution that opened it.
    assert.deepEqual(edgeSummary(result), [
      ['turn_started', 1, null],
      ['turn_failed', 1, 'session_died'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a quick double switch keeps the final execution's live turn alive while its event is queued", async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-double-switch-final-'));
  try {
    const rollout = join(root, 'rollout.jsonl');
    const ledger = prepareAgent(root, 'thread');
    const targets = stubTargets([target(10, 'codex', pty(20, 0))]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalEvents;
        const changes = yield* tapInternalEvents(['agent_session_changed']);
        // Both switches finish, and `pty:21` resumes the thread and opens a turn, before the
        // observer handles the first event. The SDK execution also resumed this thread.
        appendFileSync(
          ledger,
          [
            hookRecord('codex', 'thread', 'SessionStart', 1, ptyMark(20), {
              transcript_path: rollout,
            }),
            hookRecord(
              'codex',
              'thread',
              'SessionStart',
              10.2,
              { pty: null, sdk: 'a' },
              {
                transcript_path: rollout,
              },
            ),
            hookRecord('codex', 'thread', 'SessionStart', 11.5, ptyMark(21), {
              transcript_path: rollout,
            }),
          ].join(''),
        );
        writeFileSync(
          rollout,
          rolloutLines([
            ['session_meta', 1.5, { id: 'thread' }],
            ['event_msg', 12, { type: 'task_started', turn_id: 'turn-1' }],
          ]),
        );
        targets.set([target(10, 'codex', pty(21, 11))]);

        // Handling the SDK event reads the final target while `pty:21`'s interval is queued.
        yield* bus.publish(switched(10, 'sdk:a', 10));
        yield* changes.take;
        const afterFirstEvent = yield* observer.getTurnEdges(10);
        yield* bus.publish(switched(10, 'pty:21', 11));
        yield* changes.take;
        yield* pollHarnessLedgerObserverForTest(10);
        return {
          afterFirstEvent,
          attention: yield* observer.getAttention(10),
          edges: yield* observer.getTurnEdges(10),
        };
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { targets: targets.layer }))),
    );
    assert.deepEqual(edgeSummary(result.afterFirstEvent), [['turn_started', 1, null]]);
    assert.equal(result.attention, 'working');
    assert.deepEqual(edgeSummary(result.edges), [['turn_started', 1, null]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a poll that sees a relaunched PTY before its switch event keeps that PTY's turn alive", async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-poll-ahead-'));
  try {
    const rollout = join(root, 'rollout.jsonl');
    const ledger = prepareAgent(root, 'thread');
    const targets = stubTargets([target(10, 'codex', pty(20, 0))]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        appendFileSync(
          ledger,
          [
            hookRecord('codex', 'thread', 'SessionStart', 1, ptyMark(20), {
              transcript_path: rollout,
            }),
            hookRecord('codex', 'thread', 'SessionStart', 11.5, ptyMark(21), {
              transcript_path: rollout,
            }),
          ].join(''),
        );
        writeFileSync(
          rollout,
          rolloutLines([
            ['session_meta', 1.5, { id: 'thread' }],
            ['event_msg', 12, { type: 'task_started', turn_id: 'turn-1' }],
          ]),
        );
        // The relaunch committed, but its switch event has not been handled yet.
        targets.set([target(10, 'codex', pty(21, 11))]);
        yield* pollHarnessLedgerObserverForTest();
        return {
          attention: yield* observer.getAttention(10),
          edges: yield* observer.getTurnEdges(10),
        };
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { targets: targets.layer }))),
    );
    assert.equal(result.attention, 'working');
    assert.deepEqual(edgeSummary(result.edges), [['turn_started', 1, null]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a seed read ahead of a pending switch event still orders intervals by since', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-seed-race-'));
  try {
    const rollout = join(root, 'rollout.jsonl');
    const targets = stubTargets([]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalEvents;
        const changes = yield* tapInternalEvents(['agent_session_changed']);
        // A poll first sees agent 11 already under `sdk:a` (since 20) and seeds that interval;
        // only then is the earlier switch to `pty:21` (since 10) handled.
        targets.set([target(11, 'codex', sdk('a', 20))]);
        yield* pollHarnessLedgerObserverForTest();
        yield* bus.publish(switched(11, 'pty:21', 10));
        yield* changes.take;

        // A turn at 15 belongs to `pty:21`'s interval, whose hook is missing, so it is
        // unattributed. Were the intervals left in arrival order, 15 would precede the first
        // `since` and fall back to the older `pty:20` boundary, failing the turn as dead.
        const ledger = prepareAgent(root, 'thread', 'thread', 11);
        appendFileSync(
          ledger,
          hookRecord(
            'codex',
            'thread',
            'SessionStart',
            1,
            ptyMark(20),
            { session_id: 'thread', transcript_path: rollout },
            11,
          ),
        );
        writeFileSync(
          rollout,
          rolloutLines([
            ['session_meta', 1.5, { id: 'thread' }],
            ['event_msg', 15, { type: 'task_started', turn_id: 'turn-1' }],
          ]),
        );
        yield* pollHarnessLedgerObserverForTest(11);
        return yield* observer.getTurnEdges(11);
      }).pipe(Effect.scoped, Effect.provide(testLayer(root, { targets: targets.layer }))),
    );
    assert.deepEqual(edgeSummary(result), [['turn_started', 1, null]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Codex turn left open before an observer restart still resolves as session_died', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-codex-restart-'));
  try {
    // The surviving PTY 20 was created at 2026-06-18; the open turn is from an earlier PTY.
    await seedActiveAgentSession(root, 'codex');
    const rollout = join(root, 'rollout.jsonl');
    const ledger = prepareAgent(root, 'old-thread');
    appendFileSync(
      ledger,
      hookRecord(
        'codex',
        'old-thread',
        'SessionStart',
        0,
        ptyMark(19),
        { session_id: 'old-thread', transcript_path: rollout },
        10,
        Date.UTC(2026, 5, 17),
      ),
    );
    writeFileSync(
      rollout,
      rolloutLines(
        [
          ['session_meta', 1, { id: 'old-thread' }],
          ['event_msg', 2, { type: 'task_started', turn_id: 'turn-1' }],
        ],
        Date.UTC(2026, 5, 17),
      ),
    );
    const edges = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        return yield* observer.getTurnEdges(10);
      }).pipe(Effect.scoped, Effect.provide(testLayer(root))),
    );
    assert.deepEqual(edgeSummary(edges), [
      ['turn_started', 1, null],
      ['turn_failed', 1, 'session_died'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const sdkMark = sdkExecutionMark('execution-1');

function stubTargets(initial: readonly HarnessObservationTarget[]) {
  let current = initial;
  const isLive = (execution: ActiveExecution | null) =>
    execution?.kind === 'sdk' ||
    (execution?.kind === 'pty' &&
      (execution.status === 'running' || execution.status === 'starting'));
  return {
    set: (next: readonly HarnessObservationTarget[]) => {
      current = next;
    },
    layer: Layer.succeed(
      HarnessObservationTargets,
      HarnessObservationTargets.of({
        list: ({ mode, id }) =>
          Effect.sync(() =>
            mode === 'one'
              ? current.filter((row) => row.agentSessionId === id)
              : mode === 'live'
                ? current.filter((row) => isLive(row.activeExecution))
                : current,
          ),
      }),
    ),
  };
}

function target(
  agentSessionId: number,
  harness: AgentHarness,
  activeExecution: ActiveExecution | null,
): HarnessObservationTarget {
  return { agentSessionId, harness, activeExecution };
}

function sdk(executionId: string, sinceSeconds: number, live = true): ActiveExecution {
  return {
    kind: 'sdk',
    incarnation: `sdk:${executionId}`,
    executionId,
    live,
    since: at(sinceSeconds),
  };
}

function pty(ptyProcessId: number, sinceSeconds: number): ActiveExecution {
  return {
    kind: 'pty',
    incarnation: `pty:${ptyProcessId}`,
    ptyProcessId,
    status: 'running',
    statusReason: null,
    since: at(sinceSeconds),
  };
}

function switched(agentSessionId: number, incarnation: Incarnation, sinceSeconds: number) {
  return {
    type: 'agent_session_execution_changed' as const,
    agentSessionId,
    change: { _tag: 'switched' as const, interval: { incarnation, since: at(sinceSeconds) } },
  };
}

function readMetadata(root: string, agentSessionId: number) {
  return JSON.parse(
    readFileSync(
      join(root, 'sessions', 'agent-sessions', String(agentSessionId), 'harness.json'),
      'utf8',
    ),
  ) as { readonly harnessSessionId: string | null };
}
