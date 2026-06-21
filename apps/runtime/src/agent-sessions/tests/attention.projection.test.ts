import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { AgentSessionArtifacts } from '../artifacts.js';
import { AgentSessionAttentionProjection } from '../attention-projection.service.js';
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
