import { Fragment } from 'react';

import { AttentionDot } from '../../components/AttentionDot.js';
import { workbenchCopy } from '../../copy/index.js';
import { useActiveWorktree } from '../../lib/workspace/hooks.js';
import { branchLabel } from '../../lib/workspace/selectors.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import type { Command } from '../../lib/workspace/types.js';

/**
 * The always-on status strip — the worktree's running commands at a glance plus
 * the active branch. Commands sit beside each other (horizontal is cheap).
 * The label opens the Commands drawer; each command chip opens straight to that
 * command's logs. Failed commands stay visible here too.
 *
 * Port chips are display-only for now — wiring a port to a browser surface is
 * parked until the runtime mechanism is known.
 */
export function StatusStrip() {
  const worktree = useActiveWorktree();
  const openDrawer = useWorkspaceStore((state) => state.openDrawer);

  const commands = worktree?.commands ?? [];
  const visible = commands.filter(
    (command) => command.status === 'running' || command.attention === 'error',
  );

  return (
    <div className="flex h-7.5 flex-none items-center gap-3 border-t border-line/15 bg-elevated/50 px-3.5 text-left transition-colors duration-micro ease-expo hover:bg-elevated/70">
      {visible.length > 0 ? (
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
              <Fragment key={command.id}>
                {index > 0 && <span className="h-3 w-px flex-none bg-line/30" />}
                <CommandChip command={command} onOpen={() => openDrawer(command.id)} />
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
          {workbenchCopy.noCommandsRunning}
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

function CommandChip({ command, onOpen }: { command: Command; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-none items-center gap-2 text-fg-muted transition-colors hover:text-fg"
      title={workbenchCopy.openCommandLogsTitle(command.label)}
    >
      <AttentionDot state={command.attention} />
      <span className="font-mono text-[11px]">{command.label}</span>
      {command.status !== 'running' && (
        <span className="rounded-md border border-error/24 bg-error/10 px-1.5 py-px font-mono text-[10px] text-error">
          {command.status}
        </span>
      )}
      {command.ports.map((port) => (
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
