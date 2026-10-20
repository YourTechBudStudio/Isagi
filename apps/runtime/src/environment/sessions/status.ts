import type {
  AgentSessionRecoveryAction,
  AgentSessionStatusReason,
  SessionDiagnosticCode,
  SessionStatus,
  TerminalSessionStatusReason,
} from '@isagi/contracts';

import { ptyIncarnation, type Incarnation } from '../../harnesses/index.js';
import { exitDetail } from '../../pty-processes/index.js';
import type { AgentControl } from '../agent-sessions/interaction.js';
import type { DerivedAgentSessionState, DerivedTerminalSessionState } from '../surfaces/types.js';
import type { AgentSessionRow, TerminalSessionRow } from './types.js';

/**
 * The agent's status from its row and its current controller. In Fluidcast mode the interaction
 * overrides the persisted PTY pointer, which still names the stopped terminal.
 */
export function deriveAgentSessionState(
  session: AgentSessionRow,
  control: AgentControl,
): DerivedAgentSessionState {
  const process = session.activePtyProcess;
  if (session.harnessMetadataStatus === 'invalid') {
    return agentState(
      'failed',
      'harness_metadata_invalid',
      'harness_metadata_invalid',
      session.harnessMetadataDiagnostic ?? 'Harness metadata is invalid.',
      'create_replacement',
    );
  }
  if (session.harnessMetadataStatus === 'missing') {
    return agentState(
      'failed',
      'harness_metadata_missing',
      'harness_metadata_missing',
      'Harness metadata is missing.',
      'create_replacement',
    );
  }
  if (control.mode === 'fluidcast') {
    return control.worker.state === 'live'
      ? agentState('running', null, null, null, 'connect_existing')
      : agentState(
          'failed',
          'agent_worker_failed',
          null,
          control.worker.reason,
          'connect_existing',
        );
  }
  if (!session.activePtyProcessId) {
    return agentState('starting', null, null, null, 'connect_existing');
  }
  if (!process) {
    return session.harnessSessionId
      ? agentState(
          'failed',
          'pty_process_missing',
          'pty_process_missing',
          'No active PTY process exists for this agent session.',
          'resume_existing',
        )
      : agentState(
          'failed',
          'pty_process_missing',
          'pty_process_missing',
          'No active PTY process exists for this agent session.',
          'relaunch_fresh',
        );
  }
  switch (process.status) {
    case 'starting':
    case 'running':
      return agentState(process.status, null, null, null, 'connect_existing');
    case 'killed':
      return agentState(
        'killed',
        process.statusReason === 'runtime_shutdown' ? 'runtime_shutdown' : 'harness_process_killed',
        null,
        null,
        session.harnessSessionId ? 'resume_existing' : 'relaunch_fresh',
      );
    case 'exited':
      return agentState(
        'exited',
        'harness_process_exited',
        null,
        exitDetail(process),
        session.harnessSessionId ? 'resume_existing' : 'relaunch_fresh',
      );
    case 'failed':
      if (process.statusReason === 'backend_launch_failed')
        return session.harnessSessionId
          ? agentState(
              'failed',
              'harness_resume_failed',
              'harness_resume_failed',
              exitDetail(process),
              'resume_existing',
            )
          : agentState(
              'failed',
              'harness_launch_failed',
              'harness_launch_failed',
              exitDetail(process),
              'relaunch_fresh',
            );
      if (process.statusReason === 'backend_attach_failed')
        return agentState(
          'failed',
          'process_attach_failed',
          'pty_process_attach_failed',
          exitDetail(process),
          session.harnessSessionId ? 'resume_existing' : 'relaunch_fresh',
        );
      if (
        process.statusReason === 'backend_process_missing' ||
        process.statusReason === 'runtime_ephemeral_lost'
      )
        return session.harnessSessionId
          ? agentState(
              'failed',
              'pty_process_missing',
              'pty_process_missing',
              exitDetail(process),
              'resume_existing',
            )
          : agentState(
              'failed',
              'pty_process_missing',
              'pty_process_missing',
              exitDetail(process),
              'relaunch_fresh',
            );
      return agentState(
        'failed',
        'harness_process_exited',
        'pty_process_not_running',
        exitDetail(process),
        session.harnessSessionId ? 'resume_existing' : 'relaunch_fresh',
      );
  }
}

/**
 * The session's live terminal process incarnation, the opaque token clients bind a terminal
 * presentation to (ADR 0006). `null` whenever no terminal process is live: none launched yet, the
 * last one stopped, or (passing the agent's `control`) the agent is not in terminal mode. Under
 * Fluidcast the worker streams no terminal; after a failed switch no terminal is offered, even
 * one whose stop failed and that is still running.
 */
export function sessionProcessIncarnation(
  session: AgentSessionRow | TerminalSessionRow,
  control?: AgentControl,
): Incarnation | null {
  if (control !== undefined && control.mode !== 'terminal') return null;
  const process = session.activePtyProcess;
  if (session.activePtyProcessId === null || process === null) return null;
  return process.status === 'starting' || process.status === 'running'
    ? ptyIncarnation(session.activePtyProcessId)
    : null;
}

export function deriveTerminalSessionState(
  session: TerminalSessionRow,
): DerivedTerminalSessionState {
  const process = session.activePtyProcess;
  if (!session.activePtyProcessId) {
    return terminalState('starting', null, null, null);
  }
  if (!process) {
    return terminalState(
      'failed',
      'pty_process_missing',
      'pty_process_missing',
      'No active PTY process exists for this terminal session.',
    );
  }
  switch (process.status) {
    case 'starting':
    case 'running':
      return terminalState(process.status, null, null, null);
    case 'killed':
      return terminalState(
        'killed',
        process.statusReason === 'runtime_shutdown' ? 'runtime_shutdown' : 'shell_killed',
        null,
        null,
      );
    case 'exited':
      return terminalState('exited', 'shell_exited', null, exitDetail(process));
    case 'failed':
      if (process.statusReason === 'backend_launch_failed')
        return terminalState(
          'failed',
          'shell_launch_failed',
          'pty_process_launch_failed',
          exitDetail(process),
        );
      if (process.statusReason === 'backend_attach_failed')
        return terminalState(
          'failed',
          'process_attach_failed',
          'pty_process_attach_failed',
          exitDetail(process),
        );
      if (
        process.statusReason === 'backend_process_missing' ||
        process.statusReason === 'runtime_ephemeral_lost'
      )
        return terminalState(
          'failed',
          'pty_process_missing',
          'pty_process_missing',
          exitDetail(process),
        );
      return terminalState(
        'failed',
        'shell_exited',
        'pty_process_not_running',
        exitDetail(process),
      );
  }
}

function agentState(
  status: SessionStatus,
  statusReason: AgentSessionStatusReason | null,
  diagnosticCode: SessionDiagnosticCode | null,
  diagnosticDetail: string | null,
  recoveryAction: AgentSessionRecoveryAction,
): DerivedAgentSessionState {
  return { status, statusReason, diagnosticCode, diagnosticDetail, recoveryAction };
}

function terminalState(
  status: SessionStatus,
  statusReason: TerminalSessionStatusReason | null,
  diagnosticCode: SessionDiagnosticCode | null,
  diagnosticDetail: string | null,
): DerivedTerminalSessionState {
  return { status, statusReason, diagnosticCode, diagnosticDetail };
}
