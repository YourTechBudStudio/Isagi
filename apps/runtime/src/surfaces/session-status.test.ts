import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAgentSessionState, deriveTerminalSessionState } from './session-status.js';
import type { AgentSessionRow, TerminalSessionRow } from './types.js';

const now = '2026-06-16T00:00:00.000Z';

test('fresh never-launched agent sessions project as attachable instead of missing harness id', () => {
  const state = deriveAgentSessionState({
    id: 1,
    worktreeId: 1,
    harness: 'pi',
    cwd: '/repo',
    harnessSessionId: null,
    harnessMetadataStatus: 'valid',
    harnessMetadataDiagnostic: null,
    activePtyProcessId: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: null,
    activePtyProcess: null,
  } satisfies AgentSessionRow);

  assert.deepEqual(state, {
    status: 'starting',
    statusReason: null,
    diagnosticCode: null,
    diagnosticDetail: null,
    recoveryAction: 'connect_existing',
  });
});

test('agent sessions with a missing previous process and no observed harness id fail honestly', () => {
  const state = deriveAgentSessionState({
    id: 1,
    worktreeId: 1,
    harness: 'pi',
    cwd: '/repo',
    harnessSessionId: null,
    harnessMetadataStatus: 'valid',
    harnessMetadataDiagnostic: null,
    activePtyProcessId: 99,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: null,
    activePtyProcess: null,
  } satisfies AgentSessionRow);

  assert.equal(state.status, 'failed');
  assert.equal(state.statusReason, 'harness_session_id_missing');
  assert.equal(state.diagnosticCode, 'harness_session_id_missing');
  assert.equal(state.recoveryAction, 'create_replacement');
});

test('agent sessions with a dead previous process and no observed harness id require replacement', () => {
  const state = deriveAgentSessionState({
    id: 1,
    worktreeId: 1,
    harness: 'opencode',
    cwd: '/repo',
    harnessSessionId: null,
    harnessMetadataStatus: 'valid',
    harnessMetadataDiagnostic: null,
    activePtyProcessId: 99,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: null,
    activePtyProcess: {
      id: 99,
      backend: 'node_pty',
      backendRefJson: '{}',
      command: 'opencode',
      args: [],
      argsJson: '[]',
      cwd: '/repo',
      status: 'exited',
      statusReason: null,
      exitCode: 0,
      signal: null,
      logMode: 'none',
      logPath: null,
      createdAt: now,
      updatedAt: now,
      exitedAt: now,
      lastSeenAt: null,
    },
  } satisfies AgentSessionRow);

  assert.equal(state.status, 'exited');
  assert.equal(state.statusReason, 'harness_process_exited');
  assert.equal(state.recoveryAction, 'create_replacement');
});

test('agent sessions with a dead previous process and observed harness id require manual resume', () => {
  const state = deriveAgentSessionState({
    id: 1,
    worktreeId: 1,
    harness: 'opencode',
    cwd: '/repo',
    harnessSessionId: 'opencode-session-1',
    harnessMetadataStatus: 'valid',
    harnessMetadataDiagnostic: null,
    activePtyProcessId: 99,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: null,
    activePtyProcess: {
      id: 99,
      backend: 'node_pty',
      backendRefJson: '{}',
      command: 'opencode',
      args: [],
      argsJson: '[]',
      cwd: '/repo',
      status: 'killed',
      statusReason: 'runtime_shutdown',
      exitCode: null,
      signal: null,
      logMode: 'none',
      logPath: null,
      createdAt: now,
      updatedAt: now,
      exitedAt: now,
      lastSeenAt: null,
    },
  } satisfies AgentSessionRow);

  assert.equal(state.status, 'killed');
  assert.equal(state.statusReason, 'runtime_shutdown');
  assert.equal(state.recoveryAction, 'resume_existing');
});

test('agent sessions with invalid harness metadata require replacement', () => {
  const state = deriveAgentSessionState({
    id: 1,
    worktreeId: 1,
    harness: 'pi',
    cwd: '/repo',
    harnessSessionId: null,
    harnessMetadataStatus: 'invalid',
    harnessMetadataDiagnostic: 'Invalid harness metadata: bad json',
    activePtyProcessId: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: null,
    activePtyProcess: null,
  } satisfies AgentSessionRow);

  assert.equal(state.status, 'failed');
  assert.equal(state.statusReason, 'harness_metadata_invalid');
  assert.equal(state.diagnosticCode, 'harness_metadata_invalid');
  assert.equal(state.recoveryAction, 'create_replacement');
});

test('agent sessions with missing harness metadata require replacement', () => {
  const state = deriveAgentSessionState({
    id: 1,
    worktreeId: 1,
    harness: 'pi',
    cwd: '/repo',
    harnessSessionId: null,
    harnessMetadataStatus: 'missing',
    harnessMetadataDiagnostic: 'Harness metadata file is missing.',
    activePtyProcessId: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: null,
    activePtyProcess: null,
  } satisfies AgentSessionRow);

  assert.equal(state.status, 'failed');
  assert.equal(state.statusReason, 'harness_session_id_missing');
  assert.equal(state.diagnosticCode, 'harness_session_id_missing');
  assert.equal(state.recoveryAction, 'create_replacement');
});

test('fresh never-launched terminal sessions project as attachable', () => {
  const state = deriveTerminalSessionState({
    id: 1,
    worktreeId: 1,
    cwd: '/repo',
    shellCommand: 'bash',
    shellArgs: [],
    shellArgsJson: '[]',
    activePtyProcessId: null,
    createdAt: now,
    updatedAt: now,
    activePtyProcess: null,
  } satisfies TerminalSessionRow);

  assert.deepEqual(state, {
    status: 'starting',
    statusReason: null,
    diagnosticCode: null,
    diagnosticDetail: null,
  });
});
