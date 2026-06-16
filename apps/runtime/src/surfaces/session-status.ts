import type {
  AgentSessionStatusReason,
  SessionDiagnosticCode,
  SessionStatus,
  TerminalSessionStatusReason,
} from '@isagi/contracts';

import type {
  AgentSessionRow,
  DerivedAgentSessionState,
  DerivedTerminalSessionState,
  PtyProcessRow,
  TerminalSessionRow,
} from './types.js';

export function deriveAgentSessionState(session: AgentSessionRow): DerivedAgentSessionState {
  const process = session.activePtyProcess;
  if (!session.activePtyProcessId || !process) {
    return session.harnessSessionId
      ? agentState(
          'failed',
          'pty_process_missing',
          'pty_process_missing',
          'No active PTY process exists for this agent session.',
        )
      : agentState(
          'failed',
          'harness_session_id_missing',
          'harness_session_id_missing',
          'No harness session id has been captured for this agent session.',
        );
  }
  switch (process.status) {
    case 'starting':
    case 'running':
      return agentState(process.status, null, null, null);
    case 'killed':
      return agentState(
        'killed',
        process.statusReason === 'runtime_shutdown' ? 'runtime_shutdown' : 'harness_process_killed',
        null,
        null,
      );
    case 'exited':
      return agentState('exited', 'harness_process_exited', null, exitDetail(process));
    case 'failed':
      if (process.statusReason === 'backend_launch_failed')
        return session.harnessSessionId
          ? agentState(
              'failed',
              'harness_resume_failed',
              'harness_resume_failed',
              exitDetail(process),
            )
          : agentState(
              'failed',
              'harness_launch_failed',
              'harness_launch_failed',
              exitDetail(process),
            );
      if (process.statusReason === 'backend_attach_failed')
        return agentState(
          'failed',
          'process_attach_failed',
          'pty_process_attach_failed',
          exitDetail(process),
        );
      if (
        process.statusReason === 'backend_process_missing' ||
        process.statusReason === 'runtime_ephemeral_lost'
      )
        return session.harnessSessionId
          ? agentState('failed', 'pty_process_missing', 'pty_process_missing', exitDetail(process))
          : agentState(
              'failed',
              'harness_session_id_missing',
              'harness_session_id_missing',
              exitDetail(process) ??
                'No harness session id has been captured for this agent session.',
            );
      return agentState(
        'failed',
        'harness_process_exited',
        'pty_process_not_running',
        exitDetail(process),
      );
  }
}

export function deriveTerminalSessionState(
  session: TerminalSessionRow,
): DerivedTerminalSessionState {
  const process = session.activePtyProcess;
  if (!session.activePtyProcessId || !process) {
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
): DerivedAgentSessionState {
  return { status, statusReason, diagnosticCode, diagnosticDetail };
}

function terminalState(
  status: SessionStatus,
  statusReason: TerminalSessionStatusReason | null,
  diagnosticCode: SessionDiagnosticCode | null,
  diagnosticDetail: string | null,
): DerivedTerminalSessionState {
  return { status, statusReason, diagnosticCode, diagnosticDetail };
}

function exitDetail(process: PtyProcessRow) {
  if (process.exitCode !== null) return `PTY process exited with code ${process.exitCode}.`;
  if (process.signal) return `PTY process stopped by ${process.signal}.`;
  if (process.statusReason) return `PTY process status reason: ${process.statusReason}.`;
  return null;
}
