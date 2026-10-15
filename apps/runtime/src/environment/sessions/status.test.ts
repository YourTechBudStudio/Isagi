import assert from 'node:assert/strict';
import test from 'node:test';

import type { FluidcastSessionId } from '../../fluidcast/index.js';
import type { AgentControl } from '../agent-sessions/interaction.js';
import {
  deriveAgentSessionState,
  deriveTerminalSessionState,
  sessionProcessIncarnation,
} from './status.js';
import type { AgentSessionRow, TerminalSessionRow } from './types.js';

const now = '2026-06-16T00:00:00.000Z';
const terminal: AgentControl = { mode: 'terminal' };

function fluidcastControl(worker: Extract<AgentControl, { mode: 'fluidcast' }>['worker']) {
  return {
    mode: 'fluidcast',
    fluidcastSessionId: 'fc-1' as FluidcastSessionId,
    since: now,
    worker,
  } satisfies AgentControl;
}

/** An agent whose persisted pointer still names the terminal it stopped when it switched. */
function switchedAgent(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: 1,
    worktreeId: 1,
    harness: 'claude',
    cwd: '/repo',
    harnessSessionId: 'claude-session',
    harnessMetadataStatus: 'valid',
    harnessMetadataDiagnostic: null,
    activePtyProcessId: 99,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: null,
    activePtyProcess: ptyProcess({ id: 99, status: 'killed', statusReason: 'user_requested' }),
    ...overrides,
  };
}

test('a Fluidcast-controlled agent with a live worker is running, whatever the stopped PTY says', () => {
  assert.deepEqual(deriveAgentSessionState(switchedAgent(), fluidcastControl({ state: 'live' })), {
    status: 'running',
    statusReason: null,
    diagnosticCode: null,
    diagnosticDetail: null,
    recoveryAction: 'connect_existing',
  });
});

test('a Fluidcast-controlled agent whose worker ended is failed with agent_worker_failed', () => {
  assert.deepEqual(
    deriveAgentSessionState(
      switchedAgent(),
      fluidcastControl({ state: 'ended', reason: 'worker_exited' }),
    ),
    {
      status: 'failed',
      statusReason: 'agent_worker_failed',
      diagnosticCode: null,
      diagnosticDetail: 'worker_exited',
      recoveryAction: 'connect_existing',
    },
  );
});

test('the same stopped PTY reads as killed in terminal mode', () => {
  assert.equal(deriveAgentSessionState(switchedAgent(), terminal).status, 'killed');
});

test('invalid harness metadata still wins over Fluidcast control', () => {
  const state = deriveAgentSessionState(
    switchedAgent({ harnessMetadataStatus: 'invalid', harnessMetadataDiagnostic: 'bad json' }),
    fluidcastControl({ state: 'live' }),
  );
  assert.equal(state.status, 'failed');
  assert.equal(state.statusReason, 'harness_metadata_invalid');
});

test('fresh never-launched agent sessions project as attachable instead of missing harness id', () => {
  const state = deriveAgentSessionState(
    {
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
    } satisfies AgentSessionRow,
    terminal,
  );

  assert.deepEqual(state, {
    status: 'starting',
    statusReason: null,
    diagnosticCode: null,
    diagnosticDetail: null,
    recoveryAction: 'connect_existing',
  });
});

test('agent sessions with a missing previous process and no observed harness id relaunch fresh', () => {
  const state = deriveAgentSessionState(
    {
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
    } satisfies AgentSessionRow,
    terminal,
  );

  assert.equal(state.status, 'failed');
  assert.equal(state.statusReason, 'pty_process_missing');
  assert.equal(state.diagnosticCode, 'pty_process_missing');
  assert.equal(state.recoveryAction, 'relaunch_fresh');
});

test('agent sessions with a dead previous process and no observed harness id relaunch fresh', () => {
  const state = deriveAgentSessionState(
    {
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
    } satisfies AgentSessionRow,
    terminal,
  );

  assert.equal(state.status, 'exited');
  assert.equal(state.statusReason, 'harness_process_exited');
  assert.equal(state.recoveryAction, 'relaunch_fresh');
});

test('agent sessions killed before observing a harness id relaunch fresh', () => {
  const state = deriveAgentSessionState(
    {
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
      activePtyProcess: ptyProcess({ status: 'killed', statusReason: 'runtime_shutdown' }),
    } satisfies AgentSessionRow,
    terminal,
  );

  assert.equal(state.status, 'killed');
  assert.equal(state.statusReason, 'runtime_shutdown');
  assert.equal(state.diagnosticCode, null);
  assert.equal(state.recoveryAction, 'relaunch_fresh');
});

test('agent sessions with a failed previous launch and no observed harness id relaunch fresh', () => {
  const state = deriveAgentSessionState(
    {
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
      activePtyProcess: ptyProcess({
        status: 'failed',
        statusReason: 'backend_launch_failed',
        exitCode: 1,
      }),
    } satisfies AgentSessionRow,
    terminal,
  );

  assert.equal(state.status, 'failed');
  assert.equal(state.statusReason, 'harness_launch_failed');
  assert.equal(state.diagnosticCode, 'harness_launch_failed');
  assert.equal(state.recoveryAction, 'relaunch_fresh');
});

test('agent sessions with a dead previous process and observed harness id require manual resume', () => {
  const state = deriveAgentSessionState(
    {
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
    } satisfies AgentSessionRow,
    terminal,
  );

  assert.equal(state.status, 'killed');
  assert.equal(state.statusReason, 'runtime_shutdown');
  assert.equal(state.recoveryAction, 'resume_existing');
});

test('agent sessions with invalid harness metadata require replacement', () => {
  const state = deriveAgentSessionState(
    {
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
    } satisfies AgentSessionRow,
    terminal,
  );

  assert.equal(state.status, 'failed');
  assert.equal(state.statusReason, 'harness_metadata_invalid');
  assert.equal(state.diagnosticCode, 'harness_metadata_invalid');
  assert.equal(state.recoveryAction, 'create_replacement');
});

test('agent sessions with missing harness metadata require replacement', () => {
  const state = deriveAgentSessionState(
    {
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
    } satisfies AgentSessionRow,
    terminal,
  );

  assert.equal(state.status, 'failed');
  assert.equal(state.statusReason, 'harness_metadata_missing');
  assert.equal(state.diagnosticCode, 'harness_metadata_missing');
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

test('the process incarnation names the live terminal process, and only a live one', () => {
  const live = switchedAgent({
    activePtyProcessId: 100,
    activePtyProcess: ptyProcess({ id: 100, status: 'running' }),
  });
  assert.equal(sessionProcessIncarnation(live, terminal), 'pty:100');
  assert.equal(
    sessionProcessIncarnation(
      switchedAgent({
        activePtyProcessId: 100,
        activePtyProcess: ptyProcess({ id: 100, status: 'starting' }),
      }),
      terminal,
    ),
    'pty:100',
  );
  // Stopped, missing, or never launched: nothing to attach to.
  assert.equal(sessionProcessIncarnation(switchedAgent(), terminal), null);
  assert.equal(
    sessionProcessIncarnation(
      switchedAgent({
        activePtyProcessId: 100,
        activePtyProcess: ptyProcess({ id: 100, status: 'exited', exitCode: 0 }),
      }),
      terminal,
    ),
    null,
  );
  assert.equal(
    sessionProcessIncarnation(switchedAgent({ activePtyProcess: null }), terminal),
    null,
  );
  assert.equal(
    sessionProcessIncarnation(
      switchedAgent({ activePtyProcessId: null, activePtyProcess: null }),
      terminal,
    ),
    null,
  );
});

test('an agent under Fluidcast has no terminal process incarnation', () => {
  const live = switchedAgent({
    activePtyProcessId: 100,
    activePtyProcess: ptyProcess({ id: 100, status: 'running' }),
  });
  assert.equal(sessionProcessIncarnation(live, fluidcastControl({ state: 'live' })), null);
  assert.equal(
    sessionProcessIncarnation(switchedAgent(), fluidcastControl({ state: 'live' })),
    null,
  );
});

test('a terminal session carries the incarnation of its live shell', () => {
  const session = {
    id: 1,
    worktreeId: 1,
    cwd: '/repo',
    shellCommand: 'bash',
    shellArgs: [],
    shellArgsJson: '[]',
    activePtyProcessId: 7,
    createdAt: now,
    updatedAt: now,
    activePtyProcess: ptyProcess({ id: 7, status: 'running' }),
  } satisfies TerminalSessionRow;
  assert.equal(sessionProcessIncarnation(session), 'pty:7');
  assert.equal(
    sessionProcessIncarnation({
      ...session,
      activePtyProcess: ptyProcess({ id: 7, status: 'killed', statusReason: 'runtime_shutdown' }),
    }),
    null,
  );
});

function ptyProcess(
  overrides: Partial<NonNullable<AgentSessionRow['activePtyProcess']>> & {
    readonly status: NonNullable<AgentSessionRow['activePtyProcess']>['status'];
  },
): NonNullable<AgentSessionRow['activePtyProcess']> {
  return {
    id: 99,
    backend: 'node_pty',
    backendRefJson: '{}',
    command: 'opencode',
    args: [],
    argsJson: '[]',
    cwd: '/repo',
    statusReason: null,
    exitCode: null,
    signal: null,
    logMode: 'none',
    logPath: null,
    createdAt: now,
    updatedAt: now,
    exitedAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}
