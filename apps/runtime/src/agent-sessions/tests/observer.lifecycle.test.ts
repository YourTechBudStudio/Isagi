import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { RuntimeDatabase } from '../../persistence/index.js';
import { agentSessions, ptyProcesses } from '../../persistence/schema.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import {
  HarnessLedgerObserver,
  pollHarnessLedgerObserverForTest,
} from '../harness/observer.service.js';
import { seedActiveAgentSession, testLayer } from './test-support.js';

test('startup replay is non-publishing and cache reads return paired history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-startup-'));
  try {
    await seedActiveAgentSession(root);
    const path = prepareArtifacts(root, 'pi-session', [
      ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: { hasPendingMessages: null } }),
      ledgerRecord('pi', 'pi-session', 'agent_end', 1, { context: { hasPendingMessages: false } }),
    ]);
    assert.ok(path);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['turn_started', 'turn_ended'] });
        const edges = yield* observer.getTurnEdges(10);
        const projectionBefore = yield* observer.getProjection(10);
        yield* pollHarnessLedgerObserverForTest(observer);
        const projectionAfter = yield* observer.getProjection(10);
        yield* subscription.unsubscribe;
        return { edges, sameProjection: projectionBefore === projectionAfter };
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.deepEqual(
      result.edges.map((edge) => [edge.type, edge.seq]),
      [
        ['turn_started', 0],
        ['turn_ended', 0],
      ],
    );
    assert.equal(result.sameProjection, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude background Stop stays active and empty Stop publishes the paired terminal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-claude-'));
  try {
    await seedActiveAgentSession(root, 'claude');
    const path = prepareArtifacts(root, 'claude-session', []);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['turn_started', 'turn_ended'] });

        appendFileSync(
          path,
          `${ledgerRecord('claude', 'claude-session', 'UserPromptSubmit', 0, {})}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const started = yield* subscription.take;
        assert.equal((yield* observer.getTurnEdges(10)).at(-1)?.type, 'turn_started');

        appendFileSync(
          path,
          `${ledgerRecord('claude', 'claude-session', 'Stop', 1, {
            background_tasks: [{ task_id: 'redacted' }],
          })}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const backgroundAttention = yield* observer.getAttention(10);

        appendFileSync(
          path,
          `${ledgerRecord('claude', 'claude-session', 'UserPromptSubmit', 2, {
            prompt: '<task-notification>redacted</task-notification>',
          })}\n${ledgerRecord('claude', 'claude-session', 'Stop', 3, {
            background_tasks: [],
          })}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const ended = yield* subscription.take;
        const attention = yield* observer.getAttention(10);
        const edges = yield* observer.getTurnEdges(10);
        yield* subscription.unsubscribe;
        return { started, ended, backgroundAttention, attention, edges };
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.equal(result.started.type, 'turn_started');
    assert.equal(result.ended.type, 'turn_ended');
    assert.equal('seq' in result.started ? result.started.seq : null, 0);
    assert.equal('seq' in result.ended ? result.ended.seq : null, 0);
    assert.equal(result.backgroundAttention, 'working');
    assert.equal(result.attention, 'waiting');
    assert.deepEqual(
      result.edges.map((edge) => [edge.type, edge.seq]),
      [
        ['turn_started', 0],
        ['turn_ended', 0],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude AskUserQuestion changes attention without closing the active turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-claude-question-'));
  try {
    await seedActiveAgentSession(root, 'claude');
    const path = prepareArtifacts(root, 'claude-session', []);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalRuntimeEventBus;
        const sessionChanges = yield* bus.subscribe({ types: ['agent_session_changed'] });
        const turns = yield* bus.subscribe({ types: ['turn_started', 'turn_ended'] });

        appendFileSync(
          path,
          `${ledgerRecord('claude', 'claude-session', 'UserPromptSubmit', 0, {})}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        yield* sessionChanges.take;
        const started = yield* turns.take;

        appendFileSync(
          path,
          `${ledgerRecord('claude', 'claude-session', 'PreToolUse', 1, {
            tool_name: 'AskUserQuestion',
            tool_use_id: 'instant-question',
          })}\n${ledgerRecord('claude', 'claude-session', 'PostToolUse', 2, {
            tool_name: 'AskUserQuestion',
            tool_use_id: 'instant-question',
          })}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const instantQuestionPublished = yield* Effect.race(
          sessionChanges.take.pipe(Effect.as(true)),
          Effect.sleep('30 millis').pipe(Effect.as(false)),
        );

        appendFileSync(
          path,
          `${ledgerRecord('claude', 'claude-session', 'PreToolUse', 3, {
            tool_name: 'AskUserQuestion',
            tool_use_id: 'question-1',
          })}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        yield* sessionChanges.take;
        const waitingAttention = yield* observer.getAttention(10);
        const waitingEdges = yield* observer.getTurnEdges(10);

        appendFileSync(
          path,
          `${ledgerRecord('claude', 'claude-session', 'PostToolUseFailure', 4, {
            tool_name: 'AskUserQuestion',
            tool_use_id: 'question-1',
          })}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        yield* sessionChanges.take;
        const resumedAttention = yield* observer.getAttention(10);

        appendFileSync(
          path,
          `${ledgerRecord('claude', 'claude-session', 'Stop', 5, {
            background_tasks: [],
          })}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const ended = yield* turns.take;
        yield* sessionChanges.take;
        const endedAttention = yield* observer.getAttention(10);
        yield* sessionChanges.unsubscribe;
        yield* turns.unsubscribe;
        return {
          started,
          instantQuestionPublished,
          waitingAttention,
          waitingEdges,
          resumedAttention,
          ended,
          endedAttention,
        };
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.equal(result.started.type, 'turn_started');
    assert.equal(result.instantQuestionPublished, false);
    assert.equal(result.waitingAttention, 'waiting');
    assert.deepEqual(
      result.waitingEdges.map((edge) => edge.type),
      ['turn_started'],
    );
    assert.equal(result.resumedAttention, 'working');
    assert.equal(result.ended.type, 'turn_ended');
    assert.equal(result.endedAttention, 'waiting');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('replacement rebuilds a non-publishing baseline and seeds rebuilt edges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-rebase-'));
  try {
    await seedActiveAgentSession(root);
    const path = prepareArtifacts(root, 'pi-session', [
      ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} }),
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['turn_started', 'turn_ended'] });
        rmSync(path);
        writeFileSync(
          path,
          `${ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} })}\n${ledgerRecord('pi', 'pi-session', 'agent_end', 1, { context: { hasPendingMessages: false } })}\n`,
          { mode: 0o600 },
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const published = yield* Effect.race(
          subscription.take.pipe(Effect.as(true)),
          Effect.sleep('30 millis').pipe(Effect.as(false)),
        );
        const edges = yield* observer.getTurnEdges(10);
        yield* subscription.unsubscribe;
        return { published, edges };
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.equal(result.published, false);
    assert.deepEqual(
      result.edges.map((edge) => [edge.type, edge.seq]),
      [
        ['turn_started', 0],
        ['turn_ended', 0],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode root status owns lifecycle and session.error is non-terminal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-opencode-'));
  try {
    await seedActiveAgentSession(root, 'opencode');
    const path = prepareArtifacts(root, 'opencode-root', []);
    const edges = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        appendFileSync(
          path,
          `${ledgerRecord('opencode', 'opencode-root', 'session.status', 0, openCodeStatus('busy', 0))}\n${ledgerRecord('opencode', 'opencode-root', 'session.error', 1, openCodeEvent('session.error', 1, { error: { name: 'recoverable' } }))}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        assert.equal((yield* observer.getTurnEdges(10)).at(-1)?.type, 'turn_started');
        appendFileSync(
          path,
          `${ledgerRecord('opencode', 'opencode-root', 'session.status', 2, openCodeStatus('idle', 2))}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        return yield* observer.getTurnEdges(10);
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.deepEqual(
      edges.map((edge) => [edge.type, edge.seq]),
      [
        ['turn_started', 0],
        ['turn_ended', 0],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode question events change attention without closing the active turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-opencode-question-'));
  try {
    await seedActiveAgentSession(root, 'opencode');
    const path = prepareArtifacts(root, 'opencode-root', []);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        appendFileSync(
          path,
          `${ledgerRecord('opencode', 'opencode-root', 'session.status', 0, openCodeStatus('busy', 0))}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);

        appendFileSync(
          path,
          `${ledgerRecord('opencode', 'opencode-root', 'question.asked', 1, openCodeEvent('question.asked', 1, { id: 'que-1', questions: [] }))}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const waitingAttention = yield* observer.getAttention(10);
        const waitingEdges = yield* observer.getTurnEdges(10);

        appendFileSync(
          path,
          `${ledgerRecord('opencode', 'opencode-root', 'question.rejected', 2, openCodeEvent('question.rejected', 2, { requestID: 'que-1' }))}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const resumedAttention = yield* observer.getAttention(10);

        appendFileSync(
          path,
          `${ledgerRecord('opencode', 'opencode-root', 'session.status', 3, openCodeStatus('idle', 3))}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const endedAttention = yield* observer.getAttention(10);
        const endedEdges = yield* observer.getTurnEdges(10);
        return {
          waitingAttention,
          waitingEdges,
          resumedAttention,
          endedAttention,
          endedEdges,
        };
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.equal(result.waitingAttention, 'waiting');
    assert.deepEqual(
      result.waitingEdges.map((edge) => edge.type),
      ['turn_started'],
    );
    assert.equal(result.resumedAttention, 'working');
    assert.equal(result.endedAttention, 'waiting');
    assert.deepEqual(
      result.endedEdges.map((edge) => edge.type),
      ['turn_started', 'turn_ended'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex rollout bytes are authoritative while hook records only locate the native source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-codex-'));
  const rollout = join(root, 'native-rollout.jsonl');
  try {
    await seedActiveAgentSession(root, 'codex');
    writeFileSync(rollout, `${codexEntry('session_meta', 0, { id: 'codex-session' })}\n`);
    prepareArtifacts(root, 'codex-session', [
      ledgerRecord('codex', 'codex-session', 'SessionStart', 0, {
        session_id: 'codex-session',
        transcript_path: rollout,
      }),
    ]);
    const edges = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        assert.deepEqual(yield* observer.getTurnEdges(10), []);
        appendFileSync(
          rollout,
          `${codexEntry('event_msg', 1, { type: 'task_started', turn_id: 'turn-1' })}\n${codexEntry('event_msg', 2, { type: 'task_complete', turn_id: 'turn-1' })}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        return yield* observer.getTurnEdges(10);
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.deepEqual(
      edges.map((edge) => [edge.type, edge.seq]),
      [
        ['turn_started', 1],
        ['turn_ended', 1],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live Codex session switch publishes a fully completed first turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-codex-session-switch-'));
  const oldRollout = join(root, 'old-native-rollout.jsonl');
  const newRollout = join(root, 'new-native-rollout.jsonl');
  try {
    await seedActiveAgentSession(root, 'codex');
    writeFileSync(oldRollout, `${codexEntry('session_meta', 0, { id: 'old-session' })}\n`);
    prepareArtifacts(root, 'old-session', [
      ledgerRecord('codex', 'old-session', 'SessionStart', 0, {
        session_id: 'old-session',
        transcript_path: oldRollout,
      }),
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['turn_started', 'turn_ended'] });

        writeFileSync(
          newRollout,
          `${codexEntry('session_meta', 0, { id: 'new-session' })}\n${codexEntry('event_msg', 1, { type: 'task_started', turn_id: 'turn-1' })}\n${codexEntry('event_msg', 2, { type: 'task_complete', turn_id: 'turn-1' })}\n`,
        );
        prepareLedger(root, 'new-session', [
          ledgerRecord('codex', 'new-session', 'SessionStart', 3, {
            session_id: 'new-session',
            transcript_path: newRollout,
          }),
        ]);

        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const published = yield* Effect.all([subscription.take, subscription.take]);
        const edges = yield* observer.getTurnEdges(10);
        yield* subscription.unsubscribe;
        const metadata = readHarnessMetadata(root);
        return { published, edges, metadata };
      }).pipe(Effect.provide(testLayer(root))),
    );

    assert.deepEqual(
      result.published.map((event) => event.type),
      ['turn_started', 'turn_ended'],
    );
    assert.deepEqual(
      result.edges
        .filter((edge) => edge.harnessSessionId === 'new-session')
        .map((edge) => edge.type),
      ['turn_started', 'turn_ended'],
    );
    assert.equal(result.metadata.harnessSessionId, 'new-session');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a superseded Codex thread stops driving attention after a live thread switch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-codex-supersede-working-'));
  const oldRollout = join(root, 'old-native-rollout.jsonl');
  const newRollout = join(root, 'new-native-rollout.jsonl');
  try {
    await seedActiveAgentSession(root, 'codex');
    // The old thread is left mid-turn, exactly what `/clear` produces when the
    // user switches away before the running turn reports a terminal event.
    writeFileSync(
      oldRollout,
      `${codexEntry('session_meta', 0, { id: 'old-session' })}\n${codexEntry('event_msg', 1, { type: 'task_started', turn_id: 'turn-1' })}\n`,
    );
    prepareArtifacts(root, 'old-session', [
      ledgerRecord('codex', 'old-session', 'SessionStart', 0, {
        session_id: 'old-session',
        transcript_path: oldRollout,
      }),
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        assert.equal(yield* observer.getAttention(10), 'working');

        writeFileSync(
          newRollout,
          `${codexEntry('session_meta', 0, { id: 'new-session' })}\n${codexEntry('event_msg', 1, { type: 'task_started', turn_id: 'turn-2' })}\n${codexEntry('event_msg', 2, { type: 'task_complete', turn_id: 'turn-2' })}\n`,
        );
        prepareLedger(root, 'new-session', [
          ledgerRecord('codex', 'new-session', 'SessionStart', 3, {
            session_id: 'new-session',
            transcript_path: newRollout,
          }),
        ]);
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        return {
          attention: yield* observer.getAttention(10),
          edges: yield* observer.getTurnEdges(10),
          metadata: readHarnessMetadata(root),
        };
      }).pipe(Effect.provide(testLayer(root))),
    );

    assert.equal(result.attention, 'waiting');
    assert.equal(result.metadata.harnessSessionId, 'new-session');
    // History from the superseded thread is retained, only its attention is dropped.
    assert.ok(result.edges.some((edge) => edge.harnessSessionId === 'old-session'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a superseded failed Codex thread does not pin the new thread to error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-codex-supersede-error-'));
  const oldRollout = join(root, 'old-native-rollout.jsonl');
  const newRollout = join(root, 'new-native-rollout.jsonl');
  try {
    await seedActiveAgentSession(root, 'codex');
    writeFileSync(
      oldRollout,
      `${codexEntry('session_meta', 0, { id: 'failed-session' })}\n${codexEntry('event_msg', 1, { type: 'task_started', turn_id: 'turn-1' })}\n${codexEntry('event_msg', 2, { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' })}\n`,
    );
    prepareArtifacts(root, 'failed-session', [
      ledgerRecord('codex', 'failed-session', 'SessionStart', 0, {
        session_id: 'failed-session',
        transcript_path: oldRollout,
      }),
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        assert.equal(yield* observer.getAttention(10), 'error');

        writeFileSync(
          newRollout,
          `${codexEntry('session_meta', 0, { id: 'fresh-session' })}\n${codexEntry('event_msg', 1, { type: 'task_started', turn_id: 'turn-2' })}\n`,
        );
        prepareLedger(root, 'fresh-session', [
          ledgerRecord('codex', 'fresh-session', 'SessionStart', 3, {
            session_id: 'fresh-session',
            transcript_path: newRollout,
          }),
        ]);
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        return {
          attention: yield* observer.getAttention(10),
          metadata: readHarnessMetadata(root),
        };
      }).pipe(Effect.provide(testLayer(root))),
    );

    assert.equal(result.attention, 'working');
    assert.equal(result.metadata.harnessSessionId, 'fresh-session');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an ephemeral Codex side session cannot replace the resumable thread or hide waiting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-codex-side-'));
  const rollout = join(root, 'main-native-rollout.jsonl');
  try {
    await seedActiveAgentSession(root, 'codex');
    writeFileSync(
      rollout,
      `${codexEntry('session_meta', 0, { id: 'main-session' })}\n${codexEntry('event_msg', 1, { type: 'task_started', turn_id: 'turn-1' })}\n${codexEntry('event_msg', 2, { type: 'task_complete', turn_id: 'turn-1' })}\n`,
    );
    prepareArtifacts(root, 'main-session', [
      ledgerRecord('codex', 'main-session', 'SessionStart', 0, {
        session_id: 'main-session',
        transcript_path: rollout,
      }),
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        assert.equal(yield* observer.getAttention(10), 'waiting');

        // Reproduce the legacy hook race: `/side` wrote its ephemeral id into
        // resumable metadata even though it has no durable native rollout.
        prepareArtifacts(root, 'side-session', [
          ledgerRecord('codex', 'side-session', 'SessionStart', 4, {
            session_id: 'side-session',
            source: 'startup',
            transcript_path: null,
          }),
        ]);
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        return {
          attention: yield* observer.getAttention(10),
          metadata: readHarnessMetadata(root),
        };
      }).pipe(Effect.provide(testLayer(root))),
    );

    assert.equal(result.attention, 'waiting');
    assert.equal(result.metadata.harnessSessionId, 'main-session');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex reports degraded attention when no active stream gains a native rollout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-codex-unresolved-'));
  try {
    await seedActiveAgentSession(root, 'codex');
    prepareArtifacts(root, 'unresolved-session', [
      ledgerRecord('codex', 'unresolved-session', 'SessionStart', 0, {
        session_id: 'unresolved-session',
        transcript_path: null,
      }),
    ]);
    const attention = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        assert.equal(yield* observer.getAttention(10), 'idle');
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        return yield* observer.getAttention(10);
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.equal(attention, 'error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex recovery publishes a completed turn even when a newer recovered turn is active', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-codex-missing-'));
  const rollout = join(root, 'native-rollout.jsonl');
  try {
    await seedActiveAgentSession(root, 'codex');
    writeFileSync(
      rollout,
      `${codexEntry('session_meta', 0, { id: 'codex-session-missing' })}\n${codexEntry('event_msg', 1, { type: 'task_started', turn_id: 'turn-1' })}\n${codexEntry('event_msg', 2, { type: 'task_complete', turn_id: 'turn-1' })}\n`,
    );
    prepareArtifacts(root, 'codex-session-missing', [
      ledgerRecord('codex', 'codex-session-missing', 'SessionStart', 0, {
        session_id: 'codex-session-missing',
        transcript_path: rollout,
      }),
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['turn_started', 'turn_ended'] });
        assert.deepEqual(
          (yield* observer.getTurnEdges(10)).map((edge) => edge.type),
          ['turn_started', 'turn_ended'],
        );
        rmSync(rollout);
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const missingEdges = yield* observer.getTurnEdges(10);
        writeFileSync(
          rollout,
          `${codexEntry('session_meta', 0, { id: 'codex-session-missing' })}\n${codexEntry('event_msg', 1, { type: 'task_started', turn_id: 'turn-2' })}\n${codexEntry('event_msg', 2, { type: 'task_complete', turn_id: 'turn-2' })}\n${codexEntry('event_msg', 3, { type: 'task_started', turn_id: 'turn-3' })}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const recoveredEdges = yield* observer.getTurnEdges(10);
        const published = yield* Effect.all([
          subscription.take,
          subscription.take,
          subscription.take,
        ]);
        yield* subscription.unsubscribe;
        return { missingEdges, recoveredEdges, published };
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.deepEqual(result.missingEdges, []);
    assert.deepEqual(
      result.recoveredEdges.map((edge) => edge.type),
      ['turn_started', 'turn_ended', 'turn_started'],
    );
    assert.deepEqual(
      result.published.map((event) => event.type),
      ['turn_started', 'turn_ended', 'turn_started'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed and incomplete lines do not hide a later valid lifecycle record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-lines-'));
  try {
    await seedActiveAgentSession(root);
    const path = prepareArtifacts(root, 'pi-session', []);
    const edges = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        appendFileSync(
          path,
          `not json\n${ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} }).slice(0, 40)}`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        assert.deepEqual(yield* observer.getTurnEdges(10), []);
        const complete = ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} });
        appendFileSync(path, `${complete.slice(40)}\n`);
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        return yield* observer.getTurnEdges(10);
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.equal(edges.at(-1)?.type, 'turn_started');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('active PTY replacement fails the unresolved turn with its opening sequence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-replace-'));
  try {
    await seedActiveAgentSession(root);
    const path = prepareArtifacts(root, 'pi-session', []);
    const edges = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const database = yield* RuntimeDatabase;
        const bus = yield* InternalRuntimeEventBus;
        appendFileSync(
          path,
          `${ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} })}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        yield* database.use('replace_observer_test_pty', (db) => {
          const now = new Date().toISOString();
          db.insert(ptyProcesses)
            .values({
              id: 21,
              backend: 'node_pty',
              backendRefJson: '{}',
              command: 'pi',
              argsJson: '[]',
              cwd: '/repo/isagi',
              status: 'running',
              statusReason: null,
              exitCode: null,
              signal: null,
              logMode: 'none',
              logPath: null,
              createdAt: now,
              updatedAt: now,
              exitedAt: null,
              lastSeenAt: now,
            })
            .run();
          db.update(agentSessions)
            .set({ activePtyProcessId: 21 })
            .where(eq(agentSessions.id, 10))
            .run();
        });
        yield* bus.publish({
          type: 'agent_session_active_process_changed',
          agentSessionId: 10,
          ptyProcessId: 21,
        });
        yield* Effect.sleep('20 millis');
        // A delayed hook from the replaced process is still durable evidence,
        // but it cannot rewrite the already-published failure into success.
        appendFileSync(
          path,
          `${ledgerRecord('pi', 'pi-session', 'agent_end', 1, {
            context: { hasPendingMessages: false },
          })}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        return yield* observer.getTurnEdges(10);
      }).pipe(Effect.provide(testLayer(root))),
    );
    const failure = edges.at(-1);
    assert.equal(failure?.type, 'turn_failed');
    assert.equal(failure?.seq, 0);
    assert.equal(failure?.type === 'turn_failed' ? failure.reason : null, 'session_died');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal PTY facts fail an unresolved turn even when no artifact bytes grow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-terminal-pty-'));
  try {
    await seedActiveAgentSession(root);
    const path = prepareArtifacts(root, 'pi-session', []);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalRuntimeEventBus;
        appendFileSync(
          path,
          `${ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} })}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        const subscription = yield* bus.subscribe({
          types: ['turn_failed', 'agent_session_changed'],
        });
        yield* bus.publish({
          type: 'pty_process_exited',
          ptyProcessId: 20,
          status: 'exited',
          exitCode: 1,
          signal: null,
        });
        const failed = yield* subscription.take;
        const changed = yield* subscription.take;
        const edges = yield* observer.getTurnEdges(10);
        const attention = yield* observer.getAttention(10);
        yield* subscription.unsubscribe;
        return { failed, changed, edges, attention };
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.equal(result.failed.type, 'turn_failed');
    assert.equal(result.changed.type, 'agent_session_changed');
    assert.equal(result.edges.at(-1)?.type, 'turn_failed');
    assert.equal(result.attention, 'error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal PTY facts still publish failure when the source rebases during final tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-terminal-rebase-'));
  try {
    await seedActiveAgentSession(root);
    const path = prepareArtifacts(root, 'pi-session', [
      ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} }),
    ]);
    const failed = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['turn_failed'] });
        rmSync(path);
        writeFileSync(
          path,
          `${ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} })}\n`,
          { mode: 0o600 },
        );
        yield* bus.publish({
          type: 'pty_process_exited',
          ptyProcessId: 20,
          status: 'exited',
          exitCode: 1,
          signal: null,
        });
        const event = yield* subscription.take;
        assert.equal((yield* observer.getTurnEdges(10)).at(-1)?.type, 'turn_failed');
        yield* subscription.unsubscribe;
        return event;
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.equal(failed.type, 'turn_failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('first active-process handoff publishes after baselining a post-startup session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-first-handoff-'));
  try {
    await seedActiveAgentSession(root);
    const published = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const database = yield* RuntimeDatabase;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['agent_session_changed'] });
        yield* insertRunningAgent(database, { agentSessionId: 11, ptyProcessId: 21 });
        yield* bus.publish({
          type: 'agent_session_active_process_changed',
          agentSessionId: 11,
          ptyProcessId: 21,
        });
        const event = yield* subscription.take;
        assert.equal(yield* observer.getAttention(11), 'idle');
        yield* subscription.unsubscribe;
        return event;
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.deepEqual(published, { type: 'agent_session_changed', agentSessionId: 11 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source rebase clears incarnation-bound sticky failures before sequences restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-sticky-rebase-'));
  try {
    await seedActiveAgentSession(root);
    const path = prepareArtifacts(root, 'pi-session', [
      ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} }),
    ]);
    const edges = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const database = yield* RuntimeDatabase;
        const bus = yield* InternalRuntimeEventBus;
        yield* insertReplacementPty(database, { agentSessionId: 10, ptyProcessId: 21 });
        yield* bus.publish({
          type: 'agent_session_active_process_changed',
          agentSessionId: 10,
          ptyProcessId: 21,
        });
        yield* Effect.sleep('20 millis');
        assert.equal((yield* observer.getTurnEdges(10)).at(-1)?.type, 'turn_failed');

        rmSync(path);
        writeFileSync(
          path,
          `${ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} }, 10, 21)}\n${ledgerRecord('pi', 'pi-session', 'agent_end', 1, { context: { hasPendingMessages: false } }, 10, 21)}\n`,
          { mode: 0o600 },
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        return yield* observer.getTurnEdges(10);
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.deepEqual(
      edges.map((edge) => edge.type),
      ['turn_started', 'turn_ended'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sticky failure remains adjacent to its start before a newer active turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-sticky-order-'));
  try {
    await seedActiveAgentSession(root);
    const path = prepareArtifacts(root, 'pi-session', [
      ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} }),
    ]);
    const edges = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const database = yield* RuntimeDatabase;
        const bus = yield* InternalRuntimeEventBus;
        yield* insertReplacementPty(database, { agentSessionId: 10, ptyProcessId: 21 });
        yield* bus.publish({
          type: 'agent_session_active_process_changed',
          agentSessionId: 10,
          ptyProcessId: 21,
        });
        yield* Effect.sleep('20 millis');
        appendFileSync(
          path,
          `${ledgerRecord('pi', 'pi-session', 'agent_start', 1, { context: {} }, 10, 21)}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer, 10);
        return yield* observer.getTurnEdges(10);
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.deepEqual(
      edges.map((edge) => [edge.type, edge.seq]),
      [
        ['turn_started', 0],
        ['turn_failed', 0],
        ['turn_started', 1],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'a failed source does not prevent a valid sibling from refreshing',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'isagi-observer-source-isolation-'));
    try {
      await seedActiveAgentSession(root);
      const path = prepareArtifacts(root, 'pi-session', []);
      const unreadable = join(root, 'sessions', 'agent-sessions', '10', '00.harness.jsonl');
      writeFileSync(unreadable, '{}\n', { mode: 0o600 });
      chmodSync(unreadable, 0o000);
      const edges = await Effect.runPromise(
        Effect.gen(function* () {
          const observer = yield* HarnessLedgerObserver;
          appendFileSync(
            path,
            `${ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} })}\n`,
          );
          yield* pollHarnessLedgerObserverForTest(observer, 10);
          return yield* observer.getTurnEdges(10);
        }).pipe(Effect.provide(testLayer(root))),
      );
      assert.equal(edges.at(-1)?.type, 'turn_started');
      chmodSync(unreadable, 0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'forced PTY recompute survives an inaccessible artifact directory',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'isagi-observer-directory-failure-'));
    const directory = join(root, 'sessions', 'agent-sessions', '10');
    try {
      await seedActiveAgentSession(root);
      prepareArtifacts(root, 'pi-session', [
        ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} }),
      ]);
      const failed = await Effect.runPromise(
        Effect.gen(function* () {
          yield* HarnessLedgerObserver;
          const bus = yield* InternalRuntimeEventBus;
          const subscription = yield* bus.subscribe({ types: ['turn_failed'] });
          chmodSync(directory, 0o000);
          yield* bus.publish({
            type: 'pty_process_exited',
            ptyProcessId: 20,
            status: 'exited',
            exitCode: 1,
            signal: null,
          });
          const event = yield* subscription.take;
          yield* subscription.unsubscribe;
          return event;
        }).pipe(Effect.provide(testLayer(root))),
      );
      assert.equal(failed.type, 'turn_failed');
    } finally {
      chmodSync(directory, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'a recovered ledger baselines its existing history instead of replaying live edges',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'isagi-observer-source-recovery-'));
    try {
      await seedActiveAgentSession(root);
      const path = prepareArtifacts(root, 'pi-session', [
        ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} }),
        ledgerRecord('pi', 'pi-session', 'agent_end', 1, {
          context: { hasPendingMessages: false },
        }),
      ]);
      chmodSync(path, 0o000);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const observer = yield* HarnessLedgerObserver;
          const bus = yield* InternalRuntimeEventBus;
          const subscription = yield* bus.subscribe({ types: ['turn_started', 'turn_ended'] });
          assert.deepEqual(yield* observer.getTurnEdges(10), []);
          chmodSync(path, 0o600);
          yield* pollHarnessLedgerObserverForTest(observer, 10);
          const edges = yield* observer.getTurnEdges(10);
          const published = yield* Effect.race(
            subscription.take.pipe(Effect.as(true)),
            Effect.sleep('30 millis').pipe(Effect.as(false)),
          );
          yield* subscription.unsubscribe;
          return { edges, published };
        }).pipe(Effect.provide(testLayer(root))),
      );
      assert.deepEqual(
        result.edges.map((edge) => edge.type),
        ['turn_started', 'turn_ended'],
      );
      assert.equal(result.published, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'ledger recovery baselines provider history but publishes a simultaneous PTY failure',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'isagi-observer-recovery-terminal-'));
    try {
      await seedActiveAgentSession(root);
      const path = prepareArtifacts(root, 'pi-session', [
        ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} }),
      ]);
      chmodSync(path, 0o000);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const observer = yield* HarnessLedgerObserver;
          const bus = yield* InternalRuntimeEventBus;
          const subscription = yield* bus.subscribe({ types: ['turn_started', 'turn_failed'] });
          assert.deepEqual(yield* observer.getTurnEdges(10), []);
          chmodSync(path, 0o600);
          yield* bus.publish({
            type: 'pty_process_exited',
            ptyProcessId: 20,
            status: 'exited',
            exitCode: 1,
            signal: null,
          });
          const published = yield* subscription.take;
          const edges = yield* observer.getTurnEdges(10);
          yield* subscription.unsubscribe;
          return { published, edges };
        }).pipe(Effect.provide(testLayer(root))),
      );
      assert.equal(result.published.type, 'turn_failed');
      assert.deepEqual(
        result.edges.map((edge) => edge.type),
        ['turn_started', 'turn_failed'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'insecure artifact inventory degrades without failing observer startup',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'isagi-observer-inventory-link-'));
    const target = mkdtempSync(join(tmpdir(), 'isagi-observer-inventory-target-'));
    try {
      mkdirSync(join(root, 'sessions'), { recursive: true });
      symlinkSync(target, join(root, 'sessions', 'agent-sessions'));
      const attention = await Effect.runPromise(
        Effect.gen(function* () {
          const observer = yield* HarnessLedgerObserver;
          return yield* observer.getAttention(10);
        }).pipe(Effect.provide(testLayer(root))),
      );
      assert.equal(attention, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test('new live ledger discovery publishes once while concurrent polls serialize', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-live-discovery-'));
  try {
    await seedActiveAgentSession(root);
    const path = prepareArtifacts(root, 'pi-session', []);
    rmSync(path);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['turn_started'] });
        writeFileSync(
          path,
          `${ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} })}\n`,
          { mode: 0o600 },
        );
        yield* Effect.all(
          [
            pollHarnessLedgerObserverForTest(observer, 10),
            pollHarnessLedgerObserverForTest(observer, 10),
          ],
          { concurrency: 'unbounded' },
        );
        const first = yield* subscription.take;
        const duplicate = yield* Effect.race(
          subscription.take.pipe(Effect.as(true)),
          Effect.sleep('30 millis').pipe(Effect.as(false)),
        );
        yield* subscription.unsubscribe;
        return { first, duplicate };
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.equal(result.first.type, 'turn_started');
    assert.equal(result.duplicate, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one global poll refreshes multiple live agents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-multi-agent-'));
  try {
    await seedActiveAgentSession(root);
    const firstPath = prepareArtifacts(root, 'pi-session-10', []);
    const secondPath = prepareArtifacts(root, 'pi-session-11', [], 11);
    const edges = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        const database = yield* RuntimeDatabase;
        const bus = yield* InternalRuntimeEventBus;
        const handoff = yield* bus.subscribe({ types: ['agent_session_changed'] });
        yield* insertRunningAgent(database, { agentSessionId: 11, ptyProcessId: 21 });
        yield* bus.publish({
          type: 'agent_session_active_process_changed',
          agentSessionId: 11,
          ptyProcessId: 21,
        });
        yield* handoff.take;
        yield* handoff.unsubscribe;
        appendFileSync(
          firstPath,
          `${ledgerRecord('pi', 'pi-session-10', 'agent_start', 0, { context: {} })}\n`,
        );
        appendFileSync(
          secondPath,
          `${ledgerRecord('pi', 'pi-session-11', 'agent_start', 0, { context: {} }, 11, 21)}\n`,
        );
        yield* pollHarnessLedgerObserverForTest(observer);
        return {
          first: yield* observer.getTurnEdges(10),
          second: yield* observer.getTurnEdges(11),
        };
      }).pipe(Effect.provide(testLayer(root))),
    );
    assert.equal(edges.first.at(-1)?.type, 'turn_started');
    assert.equal(edges.second.at(-1)?.type, 'turn_started');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('observer polling fiber stops with its scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-shutdown-'));
  try {
    await seedActiveAgentSession(root);
    const path = prepareArtifacts(root, 'pi-session', []);
    const observer = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* HarnessLedgerObserver;
      }).pipe(Effect.provide(testLayer(root))),
    );
    appendFileSync(
      path,
      `${ledgerRecord('pi', 'pi-session', 'agent_start', 0, { context: {} })}\n`,
    );
    await Effect.runPromise(Effect.sleep('550 millis'));
    assert.deepEqual(await Effect.runPromise(observer.getTurnEdges(10)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function prepareArtifacts(
  root: string,
  harnessSessionId: string,
  records: readonly string[],
  agentSessionId = 10,
) {
  const directory = join(root, 'sessions', 'agent-sessions', String(agentSessionId));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, 'harness.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      harnessSessionId,
      updatedAt: '2026-07-09T00:00:00.000Z',
    })}\n`,
    { mode: 0o600 },
  );
  return prepareLedger(root, harnessSessionId, records, agentSessionId);
}

function prepareLedger(
  root: string,
  harnessSessionId: string,
  records: readonly string[],
  agentSessionId = 10,
) {
  const directory = join(root, 'sessions', 'agent-sessions', String(agentSessionId));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${Buffer.from(harnessSessionId).toString('hex')}.harness.jsonl`);
  writeFileSync(path, records.map((record) => `${record}\n`).join(''), { mode: 0o600 });
  return path;
}

function readHarnessMetadata(root: string, agentSessionId = 10) {
  return JSON.parse(
    readFileSync(
      join(root, 'sessions', 'agent-sessions', String(agentSessionId), 'harness.json'),
      'utf8',
    ),
  ) as { readonly harnessSessionId: string | null };
}

function ledgerRecord(
  harness: 'pi' | 'claude' | 'codex' | 'opencode',
  harnessSessionId: string,
  nativeEvent: string,
  seq: number,
  event: unknown,
  agentSessionId = 10,
  ptyProcessId = 20,
) {
  return JSON.stringify({
    schemaVersion: 1,
    recordedAt: time(seq),
    agentSessionId,
    harnessSessionId,
    ptyProcessId,
    harness,
    nativeEvent,
    event,
  });
}

function insertRunningAgent(
  database: import('../../persistence/index.js').RuntimeDatabaseService,
  input: { readonly agentSessionId: number; readonly ptyProcessId: number },
) {
  return database.use('insert_running_observer_agent', (db) => {
    const now = new Date().toISOString();
    db.insert(ptyProcesses)
      .values({
        id: input.ptyProcessId,
        backend: 'node_pty',
        backendRefJson: '{}',
        command: 'pi',
        argsJson: '[]',
        cwd: '/repo/isagi',
        status: 'running',
        statusReason: null,
        exitCode: null,
        signal: null,
        logMode: 'none',
        logPath: null,
        createdAt: now,
        updatedAt: now,
        exitedAt: null,
        lastSeenAt: now,
      })
      .run();
    db.insert(agentSessions)
      .values({
        id: input.agentSessionId,
        worktreeId: 1,
        harness: 'pi',
        cwd: '/repo/isagi',
        activePtyProcessId: input.ptyProcessId,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      })
      .run();
  });
}

function insertReplacementPty(
  database: import('../../persistence/index.js').RuntimeDatabaseService,
  input: { readonly agentSessionId: number; readonly ptyProcessId: number },
) {
  return database.use('replace_observer_pty', (db) => {
    const now = new Date().toISOString();
    db.insert(ptyProcesses)
      .values({
        id: input.ptyProcessId,
        backend: 'node_pty',
        backendRefJson: '{}',
        command: 'pi',
        argsJson: '[]',
        cwd: '/repo/isagi',
        status: 'running',
        statusReason: null,
        exitCode: null,
        signal: null,
        logMode: 'none',
        logPath: null,
        createdAt: now,
        updatedAt: now,
        exitedAt: null,
        lastSeenAt: now,
      })
      .run();
    db.update(agentSessions)
      .set({ activePtyProcessId: input.ptyProcessId })
      .where(eq(agentSessions.id, input.agentSessionId))
      .run();
  });
}

function codexEntry(type: string, seq: number, payload: unknown) {
  return JSON.stringify({ type, timestamp: time(seq), payload });
}

function openCodeStatus(type: 'busy' | 'idle' | 'retry', nativeOrder: number) {
  return openCodeEvent('session.status', nativeOrder, { status: { type } });
}

function openCodeEvent(type: string, nativeOrder: number, properties: Record<string, unknown>) {
  return {
    id: `evt_${nativeOrder.toString(16).padStart(12, '0')}observer`,
    type,
    properties: { sessionID: 'opencode-root', ...properties },
  };
}

function time(index: number) {
  return `2026-07-09T00:00:0${index}.000Z`;
}
