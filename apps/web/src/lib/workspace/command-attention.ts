import type { CommandRunDiagnostic, CommandStatus } from '@isagi/contracts';

import { workbenchCopy } from '../../copy/index.js';
import type { AttentionState } from './types.js';

/**
 * How a command reached the surface that is rendering it.
 *
 * `configured` is an entry the catalog still describes. `removed` is a command
 * with live runtime state whose config entry is gone from a *readable* catalog.
 * `managed` is a command with live runtime state seen through a catalog that
 * could not be read at all — its entry's presence is unknown, not absent, and
 * the two must not be worded as if they were the same fact.
 */
export type CommandPresentation = 'configured' | 'removed' | 'managed';

/**
 * The attention signal a command status carries. Shared by the drawer, the
 * detail header, the status strip, and the run-metadata block so a status can
 * never mean "working" in one place and "idle" in another.
 *
 * `suspended` is uniformly `waiting`. These surfaces render only the *active*
 * worktree, so a suspended command visible here is by construction one that has
 * not self-resolved: the runtime restarted and nothing auto-starts, the resume
 * was skipped or failed, or the launch is still queued. It is waiting on the
 * user in every case that is actually on screen.
 */
export function commandAttentionState(status: CommandStatus): AttentionState {
  switch (status) {
    case 'running':
      return 'working';
    case 'failed':
      return 'error';
    case 'suspended':
      return 'waiting';
    case 'idle':
    case 'exited':
    case 'stopped':
      return 'idle';
    default:
      return assertNever(status);
  }
}

/**
 * What a command lets the user do right now.
 *
 * Consolidated here because the drawer asked the same question in two places —
 * the list row and the detail header — with two copies of the predicate. They
 * had already drifted apart once by omission: neither knew that a suspended
 * command is stoppable.
 */
export type CommandAffordances = {
  /** Launch it, or resume it now instead of waiting for the next activation. */
  readonly canRun: boolean;
  /** Stop a live process, or clear a suspended command's resume intent. */
  readonly canStop: boolean;
  readonly canRestart: boolean;
};

export function commandAffordances(
  status: CommandStatus,
  presentation: CommandPresentation,
): CommandAffordances {
  // Only a configured command can be launched: a removed or managed entry has no
  // catalog definition to launch *from*, so offering Run would promise something
  // the runtime cannot honour.
  const configured = presentation === 'configured';
  return {
    canRun: configured && status !== 'running',
    canStop: status === 'running' || status === 'suspended',
    canRestart: configured,
  };
}

/**
 * The tone a detail notice carries. Deliberately not the raw accent name: the
 * drawer maps these to token-backed utilities, and a tone can be re-pointed at a
 * different token in one place.
 *
 * `warning` is amber rather than the `error` attention token. A command whose
 * process could not be stopped, or whose config entry is gone, is degraded and
 * still recoverable — red stays reserved for genuine destruction and genuine
 * error (design system, "Reserve red"). The four attention states have no
 * `degraded` member, so a raw warning accent is the honest choice here.
 */
export type CommandNoticeTone = 'waiting' | 'warning' | 'neutral';

export type CommandDetailNotice = {
  readonly tone: CommandNoticeTone;
  /** The voiced summary. Always web-owned copy, never a runtime string. */
  readonly text: string;
  /** Runtime- or config-authored detail, rendered under a diagnostic label. */
  readonly detail?: string | undefined;
};

/**
 * The one notice a command's detail pane shows, or none.
 *
 * This function exists to keep a promise the design makes: **there is at most
 * one notice band**. Before this, a removed-and-suspended command stacked two
 * paragraphs that said overlapping things, and a run diagnostic on a PTY-linked
 * run had nowhere to appear at all. Precedence, highest first:
 *
 * 1. `suspended` — a pending decision the user owns. The presentation-keyed copy
 *    already states the removed/managed fact, so those cases add nothing.
 * 2. a run diagnostic — a concrete failure on the latest run beats standing
 *    catalog context.
 * 3. `removed`, then `managed` — standing context about the entry itself.
 *
 * Ordinary statuses on a configured command produce `null`: no explanatory
 * paragraph ever grows under a command that is simply running, idle, or exited.
 */
export function commandDetailNotice({
  status,
  presentation,
  runDiagnostic = null,
  configDiagnostic = null,
}: {
  readonly status: CommandStatus;
  readonly presentation: CommandPresentation;
  readonly runDiagnostic?: CommandRunDiagnostic | null | undefined;
  readonly configDiagnostic?: string | null | undefined;
}): CommandDetailNotice | null {
  if (status === 'suspended') {
    return {
      tone: 'waiting',
      text: suspendedCopy(presentation),
      // A suspended managed command still carries the parse error, because
      // fixing the config is the only thing that lets it resume.
      ...(presentation === 'managed' && configDiagnostic ? { detail: configDiagnostic } : {}),
    };
  }

  if (runDiagnostic) {
    return {
      tone: 'warning',
      text: workbenchCopy.commandRunDiagnostic[runDiagnostic.reason],
      ...(runDiagnostic.detail ? { detail: runDiagnostic.detail } : {}),
    };
  }

  if (presentation === 'removed') {
    return { tone: 'warning', text: workbenchCopy.commandRemovedDetail };
  }

  if (presentation === 'managed') {
    return {
      tone: 'neutral',
      text: workbenchCopy.commandManagedDetail,
      ...(configDiagnostic ? { detail: configDiagnostic } : {}),
    };
  }

  return null;
}

function suspendedCopy(presentation: CommandPresentation): string {
  switch (presentation) {
    case 'configured':
      return workbenchCopy.commandSuspendedDetail;
    case 'removed':
      return workbenchCopy.commandSuspendedRemovedDetail;
    case 'managed':
      return workbenchCopy.commandSuspendedManagedDetail;
    default:
      return assertNever(presentation);
  }
}

/**
 * Forces a compile error if `CommandStatus` or `CommandPresentation` gains a
 * variant. A new process state is a product decision about what the user is
 * being told and what they can do about it; a fallback branch would make that
 * decision silently, which is exactly how `suspended` would have inherited
 * `idle` attention and disappeared from the status strip.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled command presentation value: ${String(value)}`);
}
