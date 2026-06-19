import {
  AlertTriangle,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  SquareChevronRight,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { CommandStatus, CommandSummary, WorktreeCommandsOutput } from '@isagi/contracts';

import { AttentionDot } from '../../components/AttentionDot.js';
import { workbenchCopy } from '../../copy/index.js';
import { surfaceTransition } from '../../lib/motion.js';
import { restoreActivePaneFocus } from '../../lib/workspace/activation.js';
import { useActiveWorktree } from '../../lib/workspace/hooks.js';
import { useWorktreeCommandsQuery } from '../../lib/workspace/queries.js';
import { formatRuntimeError } from '../../lib/workspace/runtime-data.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import type { AttentionState } from '../../lib/workspace/types.js';

const MIN_WIDTH = 380;

/**
 * The workbench drawer — a dedicated monitor for the worktree's commands. Slides
 * in from the right at full height; master-detail command list and detail.
 * Commands are processes you *watch* (logs, ports, run/stop); interactive shells
 * live on the canvas as terminal surfaces, not here. No close button — Esc or a
 * click outside dismisses it.
 */
export function WorkbenchDrawer() {
  const open = useWorkspaceStore((state) => state.drawer.open);
  const closeDrawer = useWorkspaceStore((state) => state.closeDrawer);

  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(640);
  const [expanded, setExpanded] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const closeDrawerAndRestoreFocus = useCallback(() => {
    closeDrawer();
    restoreActivePaneFocus();
  }, [closeDrawer]);

  // Dismiss on Escape or a click anywhere outside the drawer (no close button).
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDrawerAndRestoreFocus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (asideRef.current && !asideRef.current.contains(event.target as Node)) {
        closeDrawerAndRestoreFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, closeDrawerAndRestoreFocus]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setExpanded(false);
    const startX = event.clientX;
    const startWidth = widthRef.current;
    // The only real bound is the work area; drag as broad as that.
    const maxWidth = asideRef.current?.parentElement?.clientWidth ?? startWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + (startX - moveEvent.clientX);
      setWidth(Math.max(MIN_WIDTH, Math.min(maxWidth, next)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="drawer"
          ref={asideRef}
          initial={{ x: '100%', opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '100%', opacity: 0 }}
          transition={surfaceTransition}
          style={{ width: expanded ? '100%' : width }}
          className="absolute top-0 right-0 bottom-0 z-20 flex flex-col border-l border-line/24 bg-canvas/85 shadow-lift backdrop-blur-lg"
        >
          <div
            onPointerDown={startResize}
            className="group/grip absolute top-0 bottom-0 left-0 w-1.75 cursor-col-resize"
          >
            <span className="absolute top-[30%] bottom-[30%] left-0.5 w-0.5 rounded-full bg-transparent transition-colors group-hover/grip:bg-blue/45" />
          </div>

          <div className="flex h-11 flex-none items-center gap-2 border-b border-line/14 px-3.5">
            <SquareChevronRight size={14} className="text-fg-subtle" />
            <span className="font-mono text-[12px] text-fg-muted">Commands</span>
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              title={expanded ? 'Restore width' : 'Expand to full width'}
              className="ml-auto grid size-7 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg"
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>

          <div className="flex min-h-0 flex-1">
            <CommandsView />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function CommandsView() {
  const worktree = useActiveWorktree();
  const selectedId = useWorkspaceStore((state) => state.drawer.selectedCommandId);
  const selectCommand = useWorkspaceStore((state) => state.selectCommand);
  const commandsQuery = useWorktreeCommandsQuery(worktree?.id ?? null);
  const commandRead = commandsQuery.data;

  if (!worktree) {
    return <EmptyCommandsState label={workbenchCopy.emptyCommands} />;
  }

  if (commandsQuery.error) {
    return (
      <CommandDiagnosticState
        title={workbenchCopy.commandReadFailedTitle}
        body={formatRuntimeError(commandsQuery.error)}
        onRefresh={() => void commandsQuery.refetch()}
      />
    );
  }

  if (commandRead?.status === 'config_error') {
    return (
      <CommandDiagnosticState
        title={workbenchCopy.commandConfigDiagnosticTitle}
        body={workbenchCopy.commandConfigDiagnosticBody}
        diagnostic={`${commandRead.diagnostic.path}\n${commandRead.diagnostic.message}`}
        onRefresh={() => void commandsQuery.refetch()}
      />
    );
  }

  const commands = configuredCommands(commandRead);
  const selected = commands.find((command) => command.name === selectedId) ?? commands[0] ?? null;

  return (
    <>
      <div className="flex w-52 flex-none flex-col overflow-auto border-r border-line/12 p-2">
        {commandsQuery.isPending ? (
          <p className="px-2 pt-1 font-mono text-[11px] text-fg-subtle opacity-55">
            {workbenchCopy.commandsLoading}
          </p>
        ) : commands.length === 0 ? (
          <p className="px-2 pt-1 font-mono text-[11px] text-fg-subtle opacity-55">
            {workbenchCopy.emptyCommands}
          </p>
        ) : (
          commands.map((command) => (
            <div
              key={command.name}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 transition-colors ${
                command.name === selected?.name ? 'bg-white/8' : 'hover:bg-white/4'
              }`}
            >
              <button
                type="button"
                disabled
                title={workbenchCopy.commandExecutionUnavailableTitle}
                aria-label={`${command.status === 'running' ? 'Stop' : 'Run'} ${command.name}`}
                className="grid size-5 flex-none cursor-not-allowed place-items-center rounded-md border border-line/20 text-fg-subtle opacity-45"
              >
                {command.status === 'running' ? <Square size={9} /> : <Play size={9} />}
              </button>
              <button
                type="button"
                onClick={() => selectCommand(command.name)}
                aria-current={command.name === selected?.name ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <AttentionDot state={attentionForCommandStatus(command.status)} />
                <span className="truncate font-mono text-[12px] text-fg">{command.name}</span>
              </button>
            </div>
          ))
        )}
        <button
          type="button"
          disabled
          title={workbenchCopy.commandAuthoringTitle}
          className="mt-0.5 flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-2 py-2 font-mono text-[11.5px] text-fg-subtle opacity-55"
        >
          <Plus size={13} />
          new command
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? <CommandDetail command={selected} /> : null}
      </div>
    </>
  );
}

function CommandDetail({ command }: { command: CommandSummary }) {
  return (
    <>
      <div className="flex h-11 flex-none items-center gap-2.5 border-b border-line/12 px-3.5">
        <AttentionDot state={attentionForCommandStatus(command.status)} />
        <span className="font-mono text-[12px] text-fg">{command.name}</span>
        <span className="font-mono text-[10.5px] text-fg-subtle">{command.status}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {command.status === 'running' &&
            command.ports.map((port) => (
              <span
                key={port}
                className="rounded-md border border-cyan/28 bg-cyan/10 px-1.5 py-px font-mono text-[10.5px] text-cyan"
              >
                :{port}
              </span>
            ))}
          <button
            type="button"
            disabled
            title={workbenchCopy.commandExecutionUnavailableTitle}
            className="grid size-6 cursor-not-allowed place-items-center rounded-md text-fg-subtle opacity-45"
          >
            <RotateCcw size={12} />
          </button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-3">
        <p className="font-mono text-[11.5px] text-fg-subtle opacity-70">
          {workbenchCopy.commandIdleDetail}
        </p>
      </div>
    </>
  );
}

function EmptyCommandsState({ label }: { readonly label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-start p-4">
      <p className="font-mono text-[11px] text-fg-subtle opacity-55">{label}</p>
    </div>
  );
}

function CommandDiagnosticState({
  title,
  body,
  diagnostic,
  onRefresh,
}: {
  readonly title: string;
  readonly body: string;
  readonly diagnostic?: string | undefined;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle size={15} className="text-error" />
        <h2 className="font-mono text-[12px] text-fg">{title}</h2>
      </div>
      <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-fg-muted">{body}</p>
      {diagnostic && (
        <pre className="mt-4 max-h-56 overflow-auto rounded-md border border-line/18 bg-black/15 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-subtle">
          {diagnostic}
        </pre>
      )}
      <button
        type="button"
        onClick={onRefresh}
        className="mt-4 flex w-fit items-center gap-2 rounded-md border border-line/24 px-2.5 py-1.5 font-mono text-[11px] text-fg-muted transition-colors hover:border-blue/45 hover:text-fg"
      >
        <RefreshCw size={12} />
        {workbenchCopy.refreshCommands}
      </button>
    </div>
  );
}

function configuredCommands(output: WorktreeCommandsOutput | undefined) {
  return output?.status === 'configured' ? output.commands : [];
}

function attentionForCommandStatus(status: CommandStatus): AttentionState {
  if (status === 'running') return 'working';
  if (status === 'failed') return 'error';
  return 'idle';
}
