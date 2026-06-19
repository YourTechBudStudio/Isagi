import { Fragment } from 'react';

import type { CommandSummary, CommandStatus } from '@isagi/contracts';

import { AttentionDot } from '../../components/AttentionDot.js';
import { workbenchCopy } from '../../copy/index.js';
import { useActiveWorktree } from '../../lib/workspace/hooks.js';
import { useWorktreeCommandsQuery } from '../../lib/workspace/queries.js';
import { branchLabel } from '../../lib/workspace/selectors.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import type { AttentionState } from '../../lib/workspace/types.js';

type CommandChipItem = CommandSummary & {
  readonly presentation: 'configured' | 'removed' | 'managed';
};

/**
 * The always-on status strip — the worktree's running commands at a glance plus
 * the active branch. Commands sit beside each other (horizontal is cheap).
 * The label opens the Commands drawer; each command chip opens that command in
 * the drawer. Failed commands stay visible here too.
 *
 * Port chips are display-only for now — wiring a port to a browser surface is
 * parked until the runtime mechanism is known.
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
  const attention = attentionForCommandStatus(command.status);
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
        <span className="rounded-md border border-error/24 bg-error/10 px-1.5 py-px font-mono text-[10px] text-error">
          {command.status}
        </span>
      )}
      {command.presentation === 'removed' && (
        <span className="rounded-md border border-amber/24 bg-amber/10 px-1.5 py-px font-mono text-[10px] text-amber">
          {workbenchCopy.commandRemovedMarker}
        </span>
      )}
      {command.status === 'running' &&
        command.presentation === 'configured' &&
        command.ports.map((port) => (
          <span
            key={port}
            className="rounded-md border border-cyan/28 bg-cyan/10 px-1.5 py-px font-mono text-[10.5px] text-cyan"
          >
            :{port}
          </span>
        ))}
    </button>
  );
}

function visibleCommandChips(
  commands: readonly CommandSummary[],
  presentation: CommandChipItem['presentation'],
): CommandChipItem[] {
  return commands
    .filter((command) => command.status === 'running' || command.status === 'failed')
    .map((command) => ({ ...command, presentation }));
}

function attentionForCommandStatus(status: CommandStatus): AttentionState {
  if (status === 'running') return 'working';
  if (status === 'failed') return 'error';
  return 'idle';
}
