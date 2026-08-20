import { Activity, Play, TriangleAlert } from 'lucide-react';

import type { CommandActionOutput, CommandSummary, WorktreeCommandsOutput } from '@isagi/contracts';

import { paletteCopy } from '../../copy/index.js';
import { runConfiguredCommandFromPalette } from '../workspace/queries.js';
import { useWorkspaceStore } from '../workspace/store.js';
import type { ConfiguredCommandsFailureKind, PaletteContext, PaletteEntry } from './types.js';

/**
 * The `Commands` palette section: the active worktree's configured processes,
 * projected into rows.
 *
 * Two words called "command" meet here and must not blur. A *configured command*
 * is a runtime-owned worktree process described by `CommandSummary`; a *palette
 * entry* is a row this module builds. Nothing crosses between them except the
 * summary data and the closure each row captures.
 *
 * The module owns both section-specific seams — how query state becomes context,
 * and how context becomes rows — so `entries.ts` stays a flat assembly index and
 * no status or failure reasoning leaks into it.
 */

/** The context fields this section contributes. Never both at once. */
export interface ConfiguredCommandsSection {
  readonly configuredCommands?: readonly CommandSummary[] | undefined;
  readonly configuredCommandsFailure?: ConfiguredCommandsFailureKind | undefined;
}

/**
 * Project the catalog query's state into the palette context fields.
 *
 * A terminal query error wins over cached data: a failed refresh must not leave
 * possibly-stale rows standing as truth, because selecting one would launch a
 * command the user can no longer be told anything reliable about. Pending with
 * no data yields neither field, so the section is simply absent until the first
 * read lands rather than flashing a placeholder. Only the `configured` variant's
 * `commands` become rows — `removedCommands` and `managedCommands` are not
 * runnable and never reach the palette.
 */
export function configuredCommandSection(query: {
  readonly data: WorktreeCommandsOutput | undefined;
  readonly isError: boolean;
}): ConfiguredCommandsSection {
  if (query.isError) {
    return { configuredCommandsFailure: 'unavailable' };
  }
  if (query.data === undefined) {
    return {};
  }
  if (query.data.status === 'config_error') {
    return { configuredCommandsFailure: 'config_error' };
  }
  return { configuredCommands: query.data.commands };
}

/**
 * Injectable effects, so the selection branches can be tested for behavior and
 * ordering without module mocks. Production always uses the defaults.
 */
export interface ConfiguredCommandEntryDeps {
  readonly runCommand?: (worktreeId: number, commandName: string) => Promise<CommandActionOutput>;
  readonly openDrawer?: (commandName?: string) => void;
}

/**
 * Build one row per valid configured command, or a single failure row when the
 * catalog cannot be shown.
 *
 * Every row freezes its target — worktree id and command name — into its id and
 * its closure at assembly time. Nothing reads the current active worktree when a
 * row is selected, so a row can never act on a worktree the user has since
 * switched away from.
 */
export function configuredCommandEntries(
  ctx: PaletteContext,
  deps: ConfiguredCommandEntryDeps = {},
): PaletteEntry[] {
  const worktree = ctx.activeWorktree;
  if (!worktree) {
    return [];
  }

  const runCommand = deps.runCommand ?? runConfiguredCommandFromPalette;
  const openDrawer =
    deps.openDrawer ??
    ((commandName?: string) => useWorkspaceStore.getState().openDrawer(commandName));

  // Failure first, and before any row mapping: an unreadable or invalid catalog
  // means there is no trustworthy set of commands to offer, so the section is
  // exactly one honest row instead of a partial launcher.
  if (ctx.configuredCommandsFailure) {
    const copy =
      ctx.configuredCommandsFailure === 'config_error'
        ? paletteCopy.commands.failure.configError
        : paletteCopy.commands.failure.unavailable;
    return [
      {
        id: 'configured-commands-failure',
        label: copy.label,
        icon: TriangleAlert,
        group: 'worktree-commands',
        sub: copy.sub,
        tone: 'error',
        run: () => {
          // No command argument: the drawer's diagnostic surface renders
          // regardless of selection, and any prior selection is preserved.
          openDrawer();
        },
      },
    ];
  }

  return (ctx.configuredCommands ?? []).map((command) =>
    commandEntry(worktree.id, command, runCommand, openDrawer),
  );
}

function commandEntry(
  worktreeId: number,
  command: CommandSummary,
  runCommand: NonNullable<ConfiguredCommandEntryDeps['runCommand']>,
  openDrawer: NonNullable<ConfiguredCommandEntryDeps['openDrawer']>,
): PaletteEntry {
  const id = `command:${worktreeId}:${command.name}`;
  const base = {
    id,
    label: command.name,
    group: 'worktree-commands',
  } as const;

  switch (command.status) {
    case 'running':
      return {
        ...base,
        icon: Activity,
        sub: paletteCopy.commands.sub.running(command.ports),
        // A state tint, not decoration: the same `working` signal the rail and
        // status strip use for a live process.
        tone: 'working',
        run: () => {
          // Details only. Selecting a running command must never read — or
          // behave — like a restart; stop and restart live in the drawer.
          openDrawer(command.name);
        },
      };
    // Suspended joins the runnable group deliberately. Selecting it launches the
    // command exactly as a startable row does; only the word changes, because
    // the user is continuing something that already exists rather than starting
    // something fresh. Resuming early is always allowed — the activation that
    // would have resumed it re-checks state under the command lock, so a manual
    // resume cannot race a second launch into existence.
    case 'suspended':
      return {
        ...base,
        icon: Play,
        sub: paletteCopy.commands.sub.resume,
        run: async () => {
          await runCommand(worktreeId, command.name);
          openDrawer(command.name);
        },
      };
    case 'idle':
    case 'stopped':
    case 'exited':
    case 'failed':
      return {
        ...base,
        icon: Play,
        sub: paletteCopy.commands.sub.run,
        run: async () => {
          // A rejection propagates out of `run()` before the handoff, so the
          // palette keeps the failure inline and the drawer stays untouched.
          // Any resolution hands off, including the runtime's success-shaped
          // `failed` launch result: the drawer's status and run diagnostics are
          // the honest result surface, not a second report here.
          await runCommand(worktreeId, command.name);
          openDrawer(command.name);
        },
      };
    default:
      return assertNever(command.status);
  }
}

/**
 * Forces a compile error if `CommandStatus` gains a variant. A new process state
 * is a product decision about whether selecting the row launches something, and
 * that decision should not be made silently by a fallback branch.
 */
function assertNever(status: never): never {
  throw new Error(`Unhandled configured command status: ${String(status)}`);
}
