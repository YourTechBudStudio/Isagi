import { Fragment } from 'react';

import type { CommandStatus, CommandSummary } from '@isagi/contracts';

import { AttentionDot } from '../../components/AttentionDot.js';
import { LiveAnnouncement } from '../../components/LiveAnnouncement.js';
import { workbenchCopy } from '../../copy/index.js';
import type { ClipboardCopyState } from '../../hooks/clipboard-copy.js';
import { useSurfaceCopy } from '../../hooks/useSurfaceCopy.js';
import { useRuntimeLocality, type RuntimeLocality } from '../../lib/runtime/locality.js';
import {
  commandAttentionState,
  type CommandPresentation,
} from '../../lib/workspace/command-attention.js';
import { commandBadgeId, commandStripEndpoints } from '../../lib/workspace/command-ports.js';
import { useActiveWorktree } from '../../lib/workspace/hooks.js';
import { useWorktreeCommandsQuery } from '../../lib/workspace/queries.js';
import { branchLabel } from '../../lib/workspace/selectors.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import { CommandUrlBadge } from './CommandUrlBadge.js';
import { ResolvedPortBadge } from './ResolvedPortBadge.js';

type CommandChipItem = CommandSummary & {
  readonly presentation: CommandPresentation;
};

/**
 * The always-on status strip — the worktree's running commands at a glance plus
 * the active branch. Commands sit beside each other (horizontal is cheap).
 * The label opens the Commands drawer; each command chip opens that command in
 * the drawer. Failed commands stay visible here too.
 *
 * This is the **primary** endpoint surface. A running command's resolved ports
 * follow its chip as port-anchored badges reading `:5173 app`, so the port and
 * the label are both readable without any interaction and one click copies the
 * complete URL. The drawer's endpoints popover is the fallback, not the other
 * way round.
 */
export function StatusStrip() {
  const worktree = useActiveWorktree();
  const openDrawer = useWorkspaceStore((state) => state.openDrawer);
  const commandsQuery = useWorktreeCommandsQuery(worktree?.id ?? null);
  const locality = useRuntimeLocality();
  // One controller for the whole strip: every badge here writes to the same
  // clipboard and reports into the same live region, so which copy is the
  // current one is a strip-wide fact rather than a per-badge one.
  const { announcement, copyState, startCopy } = useSurfaceCopy();

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
            className="flex flex-none items-center gap-2 font-mono text-[11px] text-fg-subtle opacity-75 hover:text-fg hover:opacity-100"
          >
            <AttentionDot state="error" />
            {commandRead?.status === 'config_error'
              ? workbenchCopy.commandsConfigError
              : workbenchCopy.commandsUnavailable}
          </button>
          {visible.length > 0 && (
            <CommandGroups
              commands={visible}
              locality={locality}
              onOpen={openDrawer}
              copyState={copyState}
              onCopy={startCopy}
              className="opacity-75"
            />
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
          <CommandGroups
            commands={visible}
            locality={locality}
            onOpen={openDrawer}
            copyState={copyState}
            onCopy={startCopy}
          />
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

      {/* One region for the whole strip, outside every badge, so a confirmation
          is announced even though the badge that produced it re-renders. */}
      <LiveAnnouncement announcement={announcement} />
    </div>
  );
}

/**
 * The scrolling command region.
 *
 * It scrolls horizontally instead of clipping. The strip is 30px tall with no
 * room for a scrollbar lane, so the bar is suppressed and reachability comes
 * from wheel/trackpad scrolling and the browser's native scroll-into-view when a
 * badge takes focus — which is why every URL affordance is a real button in DOM
 * order rather than a synthesised one.
 *
 * The `commands` label and the branch tag stay outside this region, so the strip
 * keeps stable chrome at both ends however dense the middle gets.
 */
function CommandGroups({
  commands,
  locality,
  onOpen,
  copyState,
  onCopy,
  className = '',
}: {
  readonly commands: readonly CommandChipItem[];
  readonly locality: RuntimeLocality;
  readonly onOpen: (commandName: string) => void;
  readonly copyState: (badgeId: string) => ClipboardCopyState;
  readonly onCopy: (badgeId: string, url: string) => void;
  readonly className?: string;
}) {
  return (
    <span
      className={`flex min-w-0 items-center gap-3 overflow-x-auto overflow-y-hidden scrollbar-none [&::-webkit-scrollbar]:hidden ${className}`}
    >
      {commands.map((command, index) => (
        <Fragment key={`${command.presentation}:${command.name}`}>
          {index > 0 && <span className="h-3 w-px flex-none bg-line/30" />}
          {/* The chip stays the only drawer opener and the only element with
              children; endpoint badges are its siblings, because a button may
              not nest a button. */}
          <span className="flex flex-none items-center gap-1.5">
            <CommandChip command={command} onOpen={() => onOpen(command.name)} />
            {commandStripEndpoints(command.ports, locality).map((endpoint) => {
              if (endpoint.kind === 'port') {
                return <ResolvedPortBadge key={`port:${endpoint.port}`} port={endpoint.port} />;
              }
              // Two commands can expose the same URL, and one port's labels can
              // resolve to the same path, so the badge's identity is its place on
              // the strip rather than the text it copies.
              const badgeId = commandBadgeId(
                command.presentation,
                command.name,
                endpoint.port,
                endpoint.label,
              );
              return (
                <CommandUrlBadge
                  key={badgeId}
                  port={endpoint.port}
                  label={endpoint.label}
                  url={endpoint.url}
                  presentation="compact"
                  state={copyState(badgeId)}
                  onCopy={() => onCopy(badgeId, endpoint.url)}
                />
              );
            })}
          </span>
        </Fragment>
      ))}
    </span>
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
