import type { AgentHarness } from '@isagi/contracts';

// Read-side composition only: a session row carries the process the runtime
// joined onto it. The PTY domain owns the row itself (ADR 0005/0008).
import type { PtyProcessRow } from '../../pty-processes/index.js';

/**
 * Deliberately NOT `PaneSessionKind`. This is the inventory of pane-bound
 * sessions that own a PTY incarnation the runtime relaunches and collects, and
 * an editor context is not one of them: its incarnation is recreated on demand,
 * not eagerly at boot. Widening this literal would silently enroll editors in
 * session restore and session GC. That exclusion is story #8's to revisit.
 */
export interface PaneSessionBinding {
  readonly paneId: number;
  readonly sessionKind: 'agent_session' | 'terminal_session';
  readonly sessionId: number;
  readonly activePtyProcessId: number | null;
}

export interface AgentSessionRow {
  readonly id: number;
  readonly worktreeId: number;
  readonly harness: AgentHarness;
  readonly cwd: string;
  readonly harnessSessionId: string | null;
  readonly harnessMetadataStatus: 'valid' | 'missing' | 'invalid';
  readonly harnessMetadataDiagnostic: string | null;
  readonly activePtyProcessId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeenAt: string | null;
  readonly activePtyProcess: PtyProcessRow | null;
}

export interface TerminalSessionRow {
  readonly id: number;
  readonly worktreeId: number;
  readonly cwd: string;
  readonly shellCommand: string;
  readonly shellArgs: readonly string[];
  readonly shellArgsJson: string;
  readonly activePtyProcessId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activePtyProcess: PtyProcessRow | null;
}
