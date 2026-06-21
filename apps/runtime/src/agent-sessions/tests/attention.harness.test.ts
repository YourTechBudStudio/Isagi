import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { AgentSessionArtifacts } from '../artifacts.js';
import { AgentSessionAttentionProjection } from '../attention-projection.service.js';
import {
  agentSession,
  appendCommandHookRecord,
  appendNestedOpenCodeRecord,
  appendOpenCodeRecord,
  appendRecord,
  harnessLogPath,
  ptyProcess,
  testLayer,
} from './test-support.js';

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
