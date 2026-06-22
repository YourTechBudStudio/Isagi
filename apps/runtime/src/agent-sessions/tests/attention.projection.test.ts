import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { AgentSessionAttentionProjection } from '../attention-projection.service.js';
import { AgentSessionArtifacts } from '../harness/ledger.js';
import { HarnessLedgerObserver } from '../harness/observer.service.js';
import {
  agentSession,
  appendRecord,
  harnessLogPath,
  ptyProcess,
  seedActiveAgentSession,
  testLayer,
} from './test-support.js';

test('attention projection maps metadata and process degradation to error', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-errors-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        const missingMetadata = yield* attention.agentSessionAttention(
          agentSession({ harnessMetadataStatus: 'missing', harnessMetadataDiagnostic: 'missing' }),
        );
        const invalidMetadata = yield* attention.agentSessionAttention(
          agentSession({ harnessMetadataStatus: 'invalid', harnessMetadataDiagnostic: 'invalid' }),
        );
        const failedProcess = yield* attention.agentSessionAttention(
          agentSession({
            activePtyProcess: ptyProcess({ id: 20, status: 'failed' }),
          }),
        );
        return { missingMetadata, invalidMetadata, failedProcess };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, {
      missingMetadata: 'error',
      invalidMetadata: 'error',
      failedProcess: 'error',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('attention projection publishes an internal agent change when artifact projection changes', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-event-'));
  try {
    const event = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['agent_session_changed'] });
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        const jsonlPath = harnessLogPath(paths.directory);
        yield* attention.reconcileAgentSession(10);
        appendRecord(jsonlPath, 'agent_start', null);
        yield* attention.reconcileAgentSession(10);
        const changedEvent = yield* subscription.take;
        yield* subscription.unsubscribe;
        return changedEvent;
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(event, { type: 'agent_session_changed', agentSessionId: 10 });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('attention projection read-path fill is publish-free', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-first-fill-'));
  try {
    const event = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['agent_session_changed'] });

        yield* attention.agentSessionAttention(agentSession({ id: 10 }));

        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 11,
          ptyProcessId: 20,
        });
        const jsonlPath = harnessLogPath(paths.directory);
        yield* attention.reconcileAgentSession(11);
        appendRecord(jsonlPath, 'agent_start', null, { agentSessionId: 11 });
        yield* attention.reconcileAgentSession(11);
        const changedEvent = yield* subscription.take;
        yield* subscription.unsubscribe;
        return changedEvent;
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(event, { type: 'agent_session_changed', agentSessionId: 11 });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('attention projection publishes an internal agent change when harness session metadata changes', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-metadata-event-'));
  try {
    const event = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['agent_session_changed'] });
        yield* artifacts.initializeMetadata(10);
        yield* attention.reconcileAgentSession(10);
        yield* artifacts.writeHarnessSessionId({
          agentSessionId: 10,
          harnessSessionId: 'pi-session-1',
        });
        yield* attention.reconcileAgentSession(10);
        const changedEvent = yield* subscription.take;
        yield* subscription.unsubscribe;
        return changedEvent;
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(event, { type: 'agent_session_changed', agentSessionId: 10 });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('attention projection preloads DB-relevant sessions so first artifact change invalidates', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-db-preload-'));
  try {
    await seedActiveAgentSession(dataRoot);
    const event = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({ types: ['agent_session_changed'] });
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        appendRecord(harnessLogPath(paths.directory), 'agent_start', null);
        yield* attention.reconcileAgentSession(10);
        const changedEvent = yield* subscription.take;
        yield* subscription.unsubscribe;
        return changedEvent;
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(event, { type: 'agent_session_changed', agentSessionId: 10 });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('harness observer emits live turn transitions and session death once', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-turn-events-'));
  try {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const observer = yield* HarnessLedgerObserver;
        const bus = yield* InternalRuntimeEventBus;
        const subscription = yield* bus.subscribe({
          types: ['turn_started', 'turn_failed'],
        });
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        const jsonlPath = harnessLogPath(paths.directory);

        yield* observer.reconcileAgentSession(10);
        appendPiRecord(jsonlPath, {
          nativeEvent: 'agent_start',
          seq: 0,
          event: { nativeEvent: 'agent_start', context: { hasPendingMessages: null } },
        });
        yield* observer.reconcileAgentSession(10);
        const started = yield* subscription.take;

        yield* bus.publish({
          type: 'pty_process_killed',
          ptyProcessId: 20,
          status: 'killed',
          statusReason: 'user_requested',
        });
        yield* Effect.sleep('10 millis');
        yield* observer.reconcileAgentSession(10);
        const failed = yield* subscription.take;

        yield* observer.reconcileAgentSession(10);
        yield* subscription.unsubscribe;
        return { started, failed };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(events, {
      started: {
        type: 'turn_started',
        agentSessionId: 10,
        harnessSessionId: 'pi-session-1',
        seq: 0,
        recordedAt: '2026-06-18T00:00:00.000Z',
      },
      failed: {
        type: 'turn_failed',
        agentSessionId: 10,
        harnessSessionId: 'pi-session-1',
        seq: null,
        recordedAt: '2026-06-18T00:00:00.000Z',
        reason: 'session_died',
      },
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function appendPiRecord(
  path: string,
  input: {
    readonly nativeEvent: string;
    readonly seq: number;
    readonly event: unknown;
    readonly harnessSessionId?: string;
    readonly ptyProcessId?: number | null;
  },
) {
  appendFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      recordedAt: `2026-06-18T00:00:0${input.seq}.000Z`,
      agentSessionId: 10,
      harnessSessionId: input.harnessSessionId ?? 'pi-session-1',
      ptyProcessId: input.ptyProcessId ?? 20,
      harness: 'pi',
      nativeEvent: input.nativeEvent,
      event: input.event,
    })}\n`,
    'utf8',
  );
}
