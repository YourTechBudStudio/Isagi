import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { PtyForegroundState } from '../../pty-processes/index.js';
import { AgentSessionArtifacts } from '../artifacts.js';
import { AgentSessionAttentionProjection } from '../attention-projection.service.js';
import {
  agentSession,
  appendRecord,
  harnessLogPath,
  ptyProcess,
  terminalSession,
  testLayer,
} from './test-support.js';

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
