import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { DataDirectory, type DataDirectoryService } from '../persistence/index.js';
import { InternalRuntimeEventBus, InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import type { AgentSessionRow, PtyProcessRow, TerminalSessionRow } from '../surfaces/types.js';
import { AgentSessionArtifacts, AgentSessionArtifactsLive } from './artifacts.js';
import {
  AgentSessionAttentionProjection,
  AgentSessionAttentionProjectionLive,
} from './attention-projection.service.js';

test('Pi attention derives idle, working, waiting, and pending-message working from JSONL', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-pi-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        const session = agentSession({ activePtyProcess: ptyProcess({ id: 20 }) });
        const idle = yield* attention.agentSessionAttention(session);

        appendRecord(paths.jsonlPath ?? '', 'agent_start', null);
        yield* attention.reconcileAgentSession(10);
        const working = yield* attention.agentSessionAttention(session);

        appendRecord(paths.jsonlPath ?? '', 'agent_end', false);
        yield* attention.reconcileAgentSession(10);
        const waiting = yield* attention.agentSessionAttention(session);

        appendRecord(paths.jsonlPath ?? '', 'agent_end', true);
        yield* attention.reconcileAgentSession(10);
        const pendingWorking = yield* attention.agentSessionAttention(session);

        return { idle, working, waiting, pendingWorking };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, {
      idle: 'idle',
      working: 'working',
      waiting: 'waiting',
      pendingWorking: 'working',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('Pi attention ignores stale JSONL from a previous PTY process', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-stale-'));
  try {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const oldPaths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        yield* artifacts.prepareProcessArtifacts({ agentSessionId: 10, ptyProcessId: 21 });
        appendRecord(oldPaths.jsonlPath ?? '', 'agent_end', false);
        yield* attention.reconcileAgentSession(10);
        return yield* attention.agentSessionAttention(
          agentSession({ activePtyProcessId: 21, activePtyProcess: ptyProcess({ id: 21 }) }),
        );
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(state, 'idle');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

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

test('terminal attention derives from PTY lifecycle', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-terminal-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        return {
          running: attention.terminalSessionAttention(
            terminalSession({ activePtyProcess: ptyProcess({ id: 30, status: 'running' }) }),
          ),
          exited: attention.terminalSessionAttention(
            terminalSession({ activePtyProcess: ptyProcess({ id: 30, status: 'exited' }) }),
          ),
          failed: attention.terminalSessionAttention(
            terminalSession({ activePtyProcess: ptyProcess({ id: 30, status: 'failed' }) }),
          ),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, { running: 'working', exited: 'idle', failed: 'error' });
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
        yield* attention.reconcileAgentSession(10);
        appendRecord(paths.jsonlPath ?? '', 'agent_start', null);
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

function appendRecord(
  path: string,
  nativeEvent: 'agent_start' | 'agent_end',
  pending: boolean | null,
) {
  appendFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      agentSessionId: 10,
      ptyProcessId: 20,
      harness: 'pi',
      nativeEvent,
      event: {
        nativeEvent,
        context: { isIdle: pending === false, hasPendingMessages: pending },
      },
    })}\n`,
    'utf8',
  );
}

function agentSession(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: 10,
    worktreeId: 1,
    harness: 'pi',
    cwd: '/repo/isagi',
    harnessSessionId: 'pi-session-1',
    harnessMetadataStatus: 'valid',
    harnessMetadataDiagnostic: null,
    activePtyProcessId: 20,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    lastSeenAt: null,
    activePtyProcess: ptyProcess({ id: 20 }),
    ...overrides,
  };
}

function terminalSession(overrides: Partial<TerminalSessionRow> = {}): TerminalSessionRow {
  return {
    id: 30,
    worktreeId: 1,
    cwd: '/repo/isagi',
    shellCommand: 'bash',
    shellArgs: [],
    shellArgsJson: '[]',
    activePtyProcessId: 30,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    activePtyProcess: ptyProcess({ id: 30 }),
    ...overrides,
  };
}

function ptyProcess(overrides: Partial<PtyProcessRow> = {}): PtyProcessRow {
  return {
    id: 20,
    backend: 'node_pty',
    backendRefJson: '{}',
    command: 'pi',
    args: [],
    argsJson: '[]',
    cwd: '/repo/isagi',
    status: 'running',
    statusReason: null,
    exitCode: null,
    signal: null,
    logMode: 'none',
    logPath: null,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    exitedAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}

function testLayer(dataRoot: string) {
  const dataDirectoryLayer = Layer.succeed(DataDirectory, {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService);
  const artifacts = AgentSessionArtifactsLive.pipe(Layer.provide(dataDirectoryLayer));
  const internalBus = InternalRuntimeEventBusLive;
  const attention = AgentSessionAttentionProjectionLive.pipe(
    Layer.provide(dataDirectoryLayer),
    Layer.provide(artifacts),
    Layer.provide(internalBus),
  );
  return Layer.mergeAll(attention, artifacts, internalBus);
}
