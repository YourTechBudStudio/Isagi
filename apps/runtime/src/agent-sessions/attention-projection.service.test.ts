import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import {
  DataDirectory,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type DataDirectoryService,
} from '../persistence/index.js';
import { agentSessions, projects, ptyProcesses, worktrees } from '../persistence/schema.js';
import { PtyForegroundState, PtyForegroundStateLive } from '../pty-processes/index.js';
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
        const jsonlPath = harnessLogPath(paths.directory);
        const session = agentSession({ activePtyProcess: ptyProcess({ id: 20 }) });
        const idle = yield* attention.agentSessionAttention(session);

        appendRecord(jsonlPath, 'agent_start', null);
        yield* attention.reconcileAgentSession(10);
        const working = yield* attention.agentSessionAttention(session);

        appendRecord(jsonlPath, 'agent_end', false);
        yield* attention.reconcileAgentSession(10);
        const waiting = yield* attention.agentSessionAttention(session);

        appendRecord(jsonlPath, 'agent_end', true);
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

test('Pi attention preserves harness history across PTY process replacement', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-pty-replace-'));
  try {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        yield* artifacts.prepareProcessArtifacts({ agentSessionId: 10, ptyProcessId: 21 });
        appendRecord(harnessLogPath(paths.directory), 'agent_end', false);
        yield* attention.reconcileAgentSession(10);
        return yield* attention.agentSessionAttention(
          agentSession({ activePtyProcessId: 21, activePtyProcess: ptyProcess({ id: 21 }) }),
        );
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(state, 'waiting');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('Pi attention refreshes when the harness session id changes inside an agent session', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-new-harness-session-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        appendRecord(harnessLogPath(paths.directory, 'pi-session-1'), 'agent_end', false);
        yield* attention.reconcileAgentSession(10);
        const oldWaiting = yield* attention.agentSessionAttention(
          agentSession({ harnessSessionId: 'pi-session-1' }),
        );
        const newIdle = yield* attention.agentSessionAttention(
          agentSession({ harnessSessionId: 'pi-session-2' }),
        );
        appendRecord(harnessLogPath(paths.directory, 'pi-session-2'), 'agent_start', null, {
          harnessSessionId: 'pi-session-2',
        });
        yield* attention.reconcileAgentSession(10);
        const newWorking = yield* attention.agentSessionAttention(
          agentSession({ harnessSessionId: 'pi-session-2' }),
        );
        return { oldWaiting, newIdle, newWorking };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, {
      oldWaiting: 'waiting',
      newIdle: 'idle',
      newWorking: 'working',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('OpenCode attention derives working and waiting from session.status JSONL', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-opencode-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        const jsonlPath = harnessLogPath(paths.directory, 'opencode-session-1');
        const session = agentSession({
          harness: 'opencode',
          harnessSessionId: 'opencode-session-1',
          activePtyProcess: ptyProcess({ id: 20, command: 'opencode' }),
        });
        const idle = yield* attention.agentSessionAttention(session);

        appendOpenCodeRecord(jsonlPath, 'busy');
        yield* attention.reconcileAgentSession(10);
        const working = yield* attention.agentSessionAttention(session);

        appendOpenCodeRecord(jsonlPath, 'idle');
        yield* attention.reconcileAgentSession(10);
        const waiting = yield* attention.agentSessionAttention(session);

        return { idle, working, waiting };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, {
      idle: 'idle',
      working: 'working',
      waiting: 'waiting',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('OpenCode attention recovers waiting from pre-existing nested session.status logs', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-opencode-restart-'));
  try {
    const directory = join(dataRoot, 'sessions', 'agent-sessions', '10');
    const jsonlPath = harnessLogPath(directory, 'opencode-session-1');
    mkdirSync(directory, { recursive: true });
    appendNestedOpenCodeRecord(jsonlPath, 'idle');

    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        return yield* attention.agentSessionAttention(
          agentSession({
            harness: 'opencode',
            harnessSessionId: 'opencode-session-1',
            activePtyProcess: ptyProcess({ id: 20, command: 'opencode' }),
          }),
        );
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(state, 'waiting');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('Claude attention derives working and waiting from hook JSONL', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-claude-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        const jsonlPath = harnessLogPath(paths.directory, 'claude-session-1');
        const session = agentSession({
          harness: 'claude',
          harnessSessionId: 'claude-session-1',
          activePtyProcess: ptyProcess({ id: 20, command: 'claude' }),
        });
        const idle = yield* attention.agentSessionAttention(session);

        appendCommandHookRecord(jsonlPath, 'claude', 'claude-session-1', 'UserPromptSubmit');
        yield* attention.reconcileAgentSession(10);
        const working = yield* attention.agentSessionAttention(session);

        appendCommandHookRecord(jsonlPath, 'claude', 'claude-session-1', 'Stop');
        yield* attention.reconcileAgentSession(10);
        const stopWaiting = yield* attention.agentSessionAttention(session);

        appendCommandHookRecord(jsonlPath, 'claude', 'claude-session-1', 'Notification', {
          notification_type: 'idle_prompt',
        });
        yield* attention.reconcileAgentSession(10);
        const notificationWaiting = yield* attention.agentSessionAttention(session);

        return { idle, working, stopWaiting, notificationWaiting };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, {
      idle: 'idle',
      working: 'working',
      stopWaiting: 'waiting',
      notificationWaiting: 'waiting',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('Codex attention derives working and waiting from hook JSONL', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-codex-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        const jsonlPath = harnessLogPath(paths.directory, 'codex-session-1');
        const session = agentSession({
          harness: 'codex',
          harnessSessionId: 'codex-session-1',
          activePtyProcess: ptyProcess({ id: 20, command: 'codex' }),
        });
        const idle = yield* attention.agentSessionAttention(session);

        appendCommandHookRecord(jsonlPath, 'codex', 'codex-session-1', 'UserPromptSubmit');
        yield* attention.reconcileAgentSession(10);
        const working = yield* attention.agentSessionAttention(session);

        appendCommandHookRecord(jsonlPath, 'codex', 'codex-session-1', 'Stop');
        yield* attention.reconcileAgentSession(10);
        const waiting = yield* attention.agentSessionAttention(session);

        return { idle, working, waiting };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, {
      idle: 'idle',
      working: 'working',
      waiting: 'waiting',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent attention is idle when cleanly exited and error when the process is missing or failed', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-working-dead-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        appendRecord(harnessLogPath(paths.directory), 'agent_start', null);
        yield* attention.reconcileAgentSession(10);
        const exited = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcess: ptyProcess({ id: 20, status: 'exited' }) }),
        );
        const missing = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcessId: 20, activePtyProcess: null }),
        );
        const failed = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcess: ptyProcess({ id: 20, status: 'failed' }) }),
        );
        return { exited, missing, failed };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, { exited: 'idle', missing: 'error', failed: 'error' });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent attention ignores last-known waiting once the process is gone', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-waiting-dead-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        appendRecord(harnessLogPath(paths.directory), 'agent_end', false);
        yield* attention.reconcileAgentSession(10);
        const exited = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcess: ptyProcess({ id: 20, status: 'exited' }) }),
        );
        const missing = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcessId: 20, activePtyProcess: null }),
        );
        const failed = yield* attention.agentSessionAttention(
          agentSession({ activePtyProcess: ptyProcess({ id: 20, status: 'failed' }) }),
        );
        return { exited, missing, failed };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, { exited: 'idle', missing: 'error', failed: 'error' });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent attention treats only deliberate kill reasons as idle, all others as error', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-killed-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const attention = yield* AgentSessionAttentionProjection;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        // Idle observed harness state (no records yet) overlaid with a killed PTY.
        yield* attention.reconcileAgentSession(10);
        const killedByUser = yield* attention.agentSessionAttention(
          agentSession({
            activePtyProcess: ptyProcess({
              id: 20,
              status: 'killed',
              statusReason: 'user_requested',
            }),
          }),
        );
        const killedByShutdown = yield* attention.agentSessionAttention(
          agentSession({
            activePtyProcess: ptyProcess({
              id: 20,
              status: 'killed',
              statusReason: 'runtime_shutdown',
            }),
          }),
        );
        const killedByFailure = yield* attention.agentSessionAttention(
          agentSession({
            activePtyProcess: ptyProcess({
              id: 20,
              status: 'killed',
              statusReason: 'backend_process_missing',
            }),
          }),
        );
        const killedWithoutReason = yield* attention.agentSessionAttention(
          agentSession({
            activePtyProcess: ptyProcess({ id: 20, status: 'killed', statusReason: null }),
          }),
        );

        // A non-benign kill is an error even when the last-observed harness state
        // was waiting — a dead process is never "waiting on you".
        appendRecord(harnessLogPath(paths.directory), 'agent_end', false);
        yield* attention.reconcileAgentSession(10);
        const failureKillStaysError = yield* attention.agentSessionAttention(
          agentSession({
            activePtyProcess: ptyProcess({
              id: 20,
              status: 'killed',
              statusReason: 'backend_process_missing',
            }),
          }),
        );

        return {
          killedByUser,
          killedByShutdown,
          killedByFailure,
          killedWithoutReason,
          failureKillStaysError,
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, {
      killedByUser: 'idle',
      killedByShutdown: 'idle',
      killedByFailure: 'error',
      killedWithoutReason: 'error',
      failureKillStaysError: 'error',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('terminal attention treats only deliberate kill reasons as idle, all others as error', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-terminal-killed-'));
  try {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        return {
          killedByUser: attention.terminalSessionAttention(
            terminalSession({
              activePtyProcess: ptyProcess({
                id: 30,
                status: 'killed',
                statusReason: 'user_requested',
              }),
            }),
          ),
          killedByFailure: attention.terminalSessionAttention(
            terminalSession({
              activePtyProcess: ptyProcess({
                id: 30,
                status: 'killed',
                statusReason: 'runtime_ephemeral_lost',
              }),
            }),
          ),
          killedWithoutReason: attention.terminalSessionAttention(
            terminalSession({
              activePtyProcess: ptyProcess({ id: 30, status: 'killed', statusReason: null }),
            }),
          ),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(states, {
      killedByUser: 'idle',
      killedByFailure: 'error',
      killedWithoutReason: 'error',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup attention reads pre-existing harness logs before applying process lifecycle', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-attention-startup-overlay-'));
  try {
    const directory = join(dataRoot, 'sessions', 'agent-sessions', '10');
    mkdirSync(directory, { recursive: true });
    appendRecord(harnessLogPath(directory), 'agent_start', null);

    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        return yield* attention.agentSessionAttention(
          agentSession({ activePtyProcess: ptyProcess({ id: 20, status: 'running' }) }),
        );
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(state, 'working');
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
        const foreground = yield* PtyForegroundState;
        yield* foreground.set(30, 'working');
        return {
          runningForeground: attention.terminalSessionAttention(
            terminalSession({ activePtyProcess: ptyProcess({ id: 30, status: 'running' }) }),
          ),
          runningPromptReady: attention.terminalSessionAttention(
            terminalSession({ activePtyProcess: ptyProcess({ id: 31, status: 'running' }) }),
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

    assert.deepEqual(states, {
      runningForeground: 'working',
      runningPromptReady: 'idle',
      exited: 'idle',
      failed: 'error',
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

function appendRecord(
  path: string,
  nativeEvent: 'agent_start' | 'agent_end',
  pending: boolean | null,
  options: { readonly harnessSessionId?: string } = {},
) {
  const harnessSessionId = options.harnessSessionId ?? 'pi-session-1';
  appendFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      agentSessionId: 10,
      harnessSessionId,
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

function appendOpenCodeRecord(path: string, status: 'busy' | 'idle') {
  appendFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      agentSessionId: 10,
      harnessSessionId: 'opencode-session-1',
      ptyProcessId: 20,
      harness: 'opencode',
      nativeEvent: 'session.status',
      event: {
        nativeEvent: 'session.status',
        status,
      },
    })}\n`,
    'utf8',
  );
}

function appendNestedOpenCodeRecord(path: string, status: 'busy' | 'idle') {
  appendFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      agentSessionId: 10,
      harnessSessionId: 'opencode-session-1',
      ptyProcessId: 20,
      harness: 'opencode',
      nativeEvent: 'session.status',
      event: {
        nativeEvent: 'session.status',
        event: {
          id: 'evt_1',
          type: 'session.status',
          properties: {
            sessionID: 'ses_1',
            status: { type: status },
          },
        },
        status: null,
      },
    })}\n`,
    'utf8',
  );
}

function appendCommandHookRecord(
  path: string,
  harness: 'claude' | 'codex',
  harnessSessionId: string,
  nativeEvent: string,
  input: Record<string, unknown> = {},
) {
  appendFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      agentSessionId: 10,
      harnessSessionId,
      ptyProcessId: 20,
      harness,
      nativeEvent,
      event: {
        nativeEvent,
        notificationType:
          typeof input.notification_type === 'string' ? input.notification_type : null,
        input: {
          hook_event_name: nativeEvent,
          session_id: harnessSessionId,
          ...input,
        },
      },
    })}\n`,
    'utf8',
  );
}

function harnessLogPath(directory: string, harnessSessionId = 'pi-session-1') {
  return join(directory, `${Buffer.from(harnessSessionId, 'utf8').toString('hex')}.harness.jsonl`);
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

async function seedActiveAgentSession(dataRoot: string) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* RuntimeDatabase;
      yield* database.use('seed_attention_relevant_agent_session', (db) => {
        const now = '2026-06-18T00:00:00.000Z';
        db.insert(projects)
          .values({
            id: 1,
            name: 'Isagi',
            rootPath: '/repo/isagi',
            status: 'present',
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
            missingReason: null,
          })
          .run();
        db.insert(worktrees)
          .values({
            id: 1,
            projectId: 1,
            path: '/repo/isagi',
            branch: 'main',
            head: null,
            createdAt: now,
            updatedAt: now,
            firstSeenAt: now,
            lastSeenAt: now,
          })
          .run();
        db.insert(ptyProcesses)
          .values({
            id: 20,
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
            lastSeenAt: null,
          })
          .run();
        db.insert(agentSessions)
          .values({
            id: 10,
            worktreeId: 1,
            harness: 'pi',
            cwd: '/repo/isagi',
            activePtyProcessId: 20,
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
          })
          .run();
      });
    }).pipe(Effect.provide(databaseLayer(dataRoot))),
  );
}

function databaseLayer(dataRoot: string) {
  return RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer(dataRoot)));
}

function testLayer(dataRoot: string) {
  const directoryLayer = dataDirectoryLayer(dataRoot);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directoryLayer));
  const artifacts = AgentSessionArtifactsLive.pipe(Layer.provide(directoryLayer));
  const internalBus = InternalRuntimeEventBusLive;
  const foreground = PtyForegroundStateLive;
  const attention = AgentSessionAttentionProjectionLive.pipe(
    Layer.provide(directoryLayer),
    Layer.provide(database),
    Layer.provide(artifacts),
    Layer.provide(foreground),
    Layer.provide(internalBus),
  );
  return Layer.mergeAll(attention, artifacts, foreground, internalBus, database);
}

function dataDirectoryLayer(dataRoot: string) {
  return Layer.succeed(DataDirectory, {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService);
}
