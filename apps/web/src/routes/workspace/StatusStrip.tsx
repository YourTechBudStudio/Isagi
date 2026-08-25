import { Fragment } from 'react';

import type { CommandStatus, CommandSummary } from '@isagi/contracts';

import { AttentionDot } from '../../components/AttentionDot.js';
import { workbenchCopy } from '../../copy/index.js';
import {
  commandAttentionState,
  type CommandPresentation,
} from '../../lib/workspace/command-attention.js';
import { useActiveWorktree } from '../../lib/workspace/hooks.js';
import { useWorktreeCommandsQuery } from '../../lib/workspace/queries.js';
import { branchLabel } from '../../lib/workspace/selectors.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';

type CommandChipItem = CommandSummary & {
  readonly presentation: CommandPresentation;
};

/**
 * The always-on status strip — the worktree's running commands at a glance plus
 * the active branch. Commands sit beside each other (horizontal is cheap).
 * The label opens the Commands drawer; each command chip opens that command in
 * the drawer. Failed commands stay visible here too.
 *
 * Resolved endpoints are not presented here yet — this phase reset the port
 * contract, and surfacing the composed URLs is the next phase's work.
 */
export function StatusStrip() {
  const worktree = useActiveWorktree();
  const openDrawer = useWorkspaceStore((state) => state.openDrawer);
  const commandsQuery = useWorktreeCommandsQuery(worktree?.id ?? null);

  const commandRead = commandsQuery.data;
  const visible =
    commandRead?.status === 'configured'
      ? [
          ...visibleCommandChips(commandRead.commands, 'configured'),
          ...visibleCommandChips(commandRead.removedCommands, 'removed'),
        ]
      : commandRead?.status === 'config_error'
        ? visibleCommandChips(commandRead.managedCommands, 'managed')
        : [];
  const commandReadFailed = commandRead?.status === 'config_error' || Boolean(commandsQuery.error);

  return (
    <div className="flex h-7.5 flex-none items-center gap-3 border-t border-line/15 bg-elevated/50 px-3.5 text-left transition-colors duration-micro ease-expo hover:bg-elevated/70">
      {commandReadFailed ? (
        <>
          <button
            type="button"
            onClick={() => openDrawer()}
            title={commandRead?.status === 'config_error' ? commandRead.diagnostic.path : undefined}
            className="flex items-center gap-2 font-mono text-[11px] text-fg-subtle opacity-75 hover:text-fg hover:opacity-100"
          >
            <AttentionDot state="error" />
            {commandRead?.status === 'config_error'
              ? workbenchCopy.commandsConfigError
              : workbenchCopy.commandsUnavailable}
          </button>
          {visible.length > 0 && (
            <span className="flex min-w-0 items-center gap-3 overflow-hidden opacity-75">
              {visible.map((command) => (
                <CommandChip
                  key={command.name}
                  command={command}
                  onOpen={() => openDrawer(command.name)}
                />
              ))}
            </span>
          )}
        </>
      ) : visible.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => openDrawer()}
            className="flex-none font-mono text-[10px] tracking-widest text-fg-subtle uppercase hover:text-fg"
          >
            commands
          </button>
          <span className="flex min-w-0 items-center gap-3 overflow-hidden">
            {visible.map((command, index) => (
              <Fragment key={command.name}>
                {index > 0 && <span className="h-3 w-px flex-none bg-line/30" />}
                <CommandChip command={command} onOpen={() => openDrawer(command.name)} />
              </Fragment>
            ))}
          </span>
        </>
      ) : (
        <button
          type="button"
          onClick={() => openDrawer()}
          className="font-mono text-[11px] text-fg-subtle opacity-55 hover:text-fg hover:opacity-100"
        >
          {commandsQuery.isPending && worktree
            ? workbenchCopy.commandsLoading
            : workbenchCopy.noCommandsRunning}
        </button>
      )}

      {worktree && (
        <span className="ml-auto flex-none font-mono text-[11.5px] text-green">
          {branchLabel(worktree)}
        </span>
      )}
    </div>
  );
}

function CommandChip({ command, onOpen }: { command: CommandChipItem; onOpen: () => void }) {
  const attention = commandAttentionState(command.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-none items-center gap-2 text-fg-muted transition-colors hover:text-fg"
      title={workbenchCopy.openCommandLogsTitle(command.name)}
    >
      <AttentionDot state={attention} />
      <span className="font-mono text-[11px]">{command.name}</span>
      {command.status !== 'running' && (
        <span
          className={`rounded-md border px-1.5 py-px font-mono text-[10px] ${statusBadgeTokens(command.status)}`}
        >
          {command.status}
        </span>
      )}
      {command.presentation === 'removed' && (
        <span className="rounded-md border border-amber/24 bg-amber/10 px-1.5 py-px font-mono text-[10px] text-amber">
          {workbenchCopy.commandRemovedMarker}
        </span>
      )}
    </button>
  );
}

/**
 * Which commands earn a chip on the always-on strip.
 *
 * `suspended` is here for every presentation, not just configured ones. During a
 * normal switch the previous worktree's chips are not rendered at all and the
 * destination's suspended chips last only the seconds of resume backlog; the
 * case that matters is the one where the suspension does *not* self-resolve —
 * after a runtime restart, or when the resume is blocked — and silently dropping
 * the chip there would hide a process the user is expected to act on.
 */
function visibleCommandChips(
  commands: readonly CommandSummary[],
  presentation: CommandPresentation,
): CommandChipItem[] {
  return commands
    .filter(
      (command) =>
        command.status === 'running' ||
        command.status === 'failed' ||
        command.status === 'suspended',
    )
    .map((command) => ({ ...command, presentation }));
}

/**
 * The badge tones a visible non-running chip can carry. State colour comes from
 * the attention semantics rather than a raw accent, so `suspended` reads as the
 * same `waiting` signal its dot already carries instead of borrowing the error
 * tones every non-running status used to share.
 */
function statusBadgeTokens(status: CommandStatus): string {
  return commandAttentionState(status) === 'waiting'
    ? 'border-waiting/24 bg-waiting/10 text-waiting'
    : 'border-error/24 bg-error/10 text-error';
}
