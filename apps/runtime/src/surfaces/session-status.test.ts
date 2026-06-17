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
    harnessSessionRefJson: null,
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
  });
});

test('agent sessions with a missing previous process and no observed harness id fail honestly', () => {
  const state = deriveAgentSessionState({
    id: 1,
    worktreeId: 1,
    harness: 'pi',
    cwd: '/repo',
    harnessSessionId: null,
    harnessSessionRefJson: null,
    activePtyProcessId: 99,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: null,
    activePtyProcess: null,
  } satisfies AgentSessionRow);

  assert.equal(state.status, 'failed');
  assert.equal(state.statusReason, 'harness_session_id_missing');
  assert.equal(state.diagnosticCode, 'harness_session_id_missing');
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
