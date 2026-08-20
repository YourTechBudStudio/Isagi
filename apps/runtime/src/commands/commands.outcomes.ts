import type { CommandRunDiagnosticReason, CommandRunStatus, CommandStatus } from '@isagi/contracts';

// How a terminal PTY incarnation becomes a terminal command run. Both the launch
// handshake and the PTY event reconciler read this module, so a verdict reached
// at launch time and the same verdict reached later cannot drift.

// Terminal outcomes written to run history. Kept on `CommandRunStatus` so a
// wider durable entity status can never leak into a completed run row.
export type TerminalRunStatus = Exclude<CommandRunStatus, 'running'>;

export interface CommandRunDiagnosticInput {
  readonly reason: CommandRunDiagnosticReason;
  readonly detail: string | null;
}

// Written by both the shutdown-kill event mapping and boot reconciliation. One
// constant, because the two orderings of the same teardown must be
// indistinguishable to the user: whichever path records the interruption, the
// diagnostic text is the same bytes.
export const runtimeStoppedDiagnosticDetail =
  'Runtime stopped while this command was running. Not restarted.';

// The terminal facts of a PTY incarnation, however they were observed: read off
// the persisted row during the launch handshake, or carried by a published
// lifecycle event.
export interface TerminalPtyFacts {
  readonly status: 'exited' | 'failed' | 'killed';
  readonly exitCode?: number | null | undefined;
  readonly statusReason?: string | null | undefined;
}

export interface TerminalCommandOutcome {
  readonly runStatus: TerminalRunStatus;
  readonly diagnostic: CommandRunDiagnosticInput | null;
}

// The one mapping from a terminal PTY fact to what it means for the command,
// shared by the launch handshake and the event reconciler so a verdict reached
// at launch time and the same verdict reached later cannot drift.
//
// Context changes only the diagnostic, never the status. During a launch, any
// `failed` row is a failed launch from the caller's perspective — whatever
// classified it — so it carries `pty_launch_failed`; the same row observed later
// through a generic `pty_process_failed` event is just a failure, with no launch
// claim attached. A shutdown kill carries its diagnostic in both contexts.
export function terminalCommandOutcomeForPtyRow(
  row: TerminalPtyFacts,
  context: 'launch' | 'event',
): TerminalCommandOutcome {
  if (row.status === 'exited') {
    return { runStatus: row.exitCode === 0 ? 'exited' : 'failed', diagnostic: null };
  }
  // A kill nobody in the command domain initiated is only `stopped` when it was
  // user-requested; every other cause (runtime shutdown, cleanup) is a failure.
  if (row.status === 'killed') {
    if (row.statusReason === 'user_requested') return { runStatus: 'stopped', diagnostic: null };
    if (row.statusReason === 'runtime_shutdown') {
      return {
        runStatus: 'failed',
        diagnostic: { reason: 'runtime_stopped', detail: runtimeStoppedDiagnosticDetail },
      };
    }
    return { runStatus: 'failed', diagnostic: null };
  }
  return {
    runStatus: 'failed',
    diagnostic:
      context === 'launch'
        ? { reason: 'pty_launch_failed', detail: row.statusReason ?? null }
        : null,
  };
}

// Narrows a persisted PTY row to its terminal facts, or null while it is still
// `starting`/`running`.
export function terminalPtyFactsForRow(
  row: {
    readonly status: string;
    readonly exitCode: number | null;
    readonly statusReason: string | null;
  } | null,
): TerminalPtyFacts | null {
  if (!row) return null;
  if (row.status !== 'exited' && row.status !== 'failed' && row.status !== 'killed') return null;
  return { status: row.status, exitCode: row.exitCode, statusReason: row.statusReason };
}

// Why a command is being stopped. The cause is decided at the call site and
// bound only to that attempt's own affirmative outcome: it is what separates a
// worktree switch's verified kill (which mints resume intent) from a person
// stopping the command (which clears it). There is no default — every stop
// origin names one — and no cause outlives its stop call.
export type CommandStopCause = 'user' | 'deactivation';

// What a stop attempt actually did. `unchanged` covers every no-op: a command
// that was not running, a deactivation meeting an existing suspension, and an
// `already_absent` termination whose real terminal fact belongs to whatever
// ended the process. `unassociated` is the pointerless dead-end — a manufactured
// `failed`, kept distinct from `converged` so a pass can tell "this command's
// process really ended" from "no process could be associated with it".
export type CommandStopResolution =
  | 'suspended'
  | 'stopped'
  | 'converged'
  | 'unassociated'
  | 'unchanged';

export interface CommandStopResult {
  readonly status: CommandStatus;
  readonly resolution: CommandStopResolution;
}
