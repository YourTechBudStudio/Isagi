import {
  AlertTriangle,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type {
  CommandRunDiagnosticReason,
  CommandStatus,
  CommandSummary,
  WorktreeCommandsOutput,
} from '@isagi/contracts';

import { AttentionDot } from '../../components/AttentionDot.js';
import { workbenchCopy } from '../../copy/index.js';
import { surfaceTransition } from '../../lib/motion.js';
import { restoreActivePaneFocus } from '../../lib/workspace/activation.js';
import { commandLogDisplayState } from '../../lib/workspace/command-log/display.js';
import { useCommandLogStream } from '../../lib/workspace/command-log/stream.js';
import { useActiveWorktree } from '../../lib/workspace/hooks.js';
import {
  useCommandLogMetadataQuery,
  useRestartCommandMutation,
  useRunCommandMutation,
  useStopCommandMutation,
  useWorktreeCommandsQuery,
} from '../../lib/workspace/queries.js';
import { formatRuntimeError } from '../../lib/workspace/runtime-data.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import type { AttentionState } from '../../lib/workspace/types.js';
import { XtermSurface } from './XtermSurface.js';

const MIN_WIDTH = 800;
const DEFAULT_WIDTH = `max(${MIN_WIDTH}px, 60vw)`;

type CommandPresentation = 'configured' | 'removed' | 'managed';

type CommandListItem = CommandSummary & {
  readonly presentation: CommandPresentation;
};

/**
 * The workbench drawer — a dedicated monitor for the worktree's commands. Slides
 * in from the right at full height; master-detail command list and detail.
 * Commands are processes you *watch* (logs, ports, run/stop); interactive shells
 * live on the canvas as terminal surfaces, not here.
 */
export function WorkbenchDrawer() {
  const open = useWorkspaceStore((state) => state.drawer.open);
  const closeDrawer = useWorkspaceStore((state) => state.closeDrawer);

  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const closeDrawerAndRestoreFocus = useCallback(() => {
    closeDrawer();
    restoreActivePaneFocus();
  }, [closeDrawer]);

  // Dismiss on Escape or a click anywhere outside the drawer.
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
    const startWidth =
      asideRef.current?.getBoundingClientRect().width ?? widthRef.current ?? MIN_WIDTH;
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
          style={{ width: expanded ? '100%' : (width ?? DEFAULT_WIDTH) }}
          className="absolute top-0 right-0 bottom-0 z-20 flex flex-col border-l border-line/24 bg-canvas/85 shadow-lift backdrop-blur-lg"
        >
          <div
            onPointerDown={startResize}
            className="group/grip absolute top-0 bottom-0 left-0 w-1.75 cursor-col-resize"
          >
            <span className="absolute top-[30%] bottom-[30%] left-0.5 w-0.5 rounded-full bg-transparent transition-colors group-hover/grip:bg-blue/45" />
          </div>

          <div className="flex h-11 flex-none items-center gap-2 border-b border-line/14 px-3.5">
            <span className="font-mono text-[12px] text-fg-muted">Commands</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                title={expanded ? 'Restore width' : 'Expand to full width'}
                className="grid size-7 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg"
              >
                {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                type="button"
                onClick={closeDrawerAndRestoreFocus}
                title="Close commands drawer"
                className="grid size-7 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg"
              >
                <X size={14} />
              </button>
            </div>
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
  const runCommand = useRunCommandMutation(worktree?.id ?? null);
  const stopCommand = useStopCommandMutation(worktree?.id ?? null);
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
    const managedCommands = commandRead.managedCommands.map((command) =>
      commandItem(command, 'managed'),
    );
    const selected =
      managedCommands.find((command) => command.name === selectedId) ?? managedCommands[0] ?? null;

    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <CommandDiagnosticPanel
          title={workbenchCopy.commandConfigDiagnosticTitle}
          body={workbenchCopy.commandConfigDiagnosticBody}
          diagnostic={`${commandRead.diagnostic.path}\n${commandRead.diagnostic.message}`}
          onRefresh={() => void commandsQuery.refetch()}
        />
        {managedCommands.length > 0 ? (
          <div className="flex min-h-0 flex-1 border-t border-line/12">
            <CommandList
              sections={[{ title: workbenchCopy.commandManagedSection, commands: managedCommands }]}
              selected={selected}
              onSelect={selectCommand}
              runCommand={runCommand}
              stopCommand={stopCommand}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              {selected ? <CommandDetail command={selected} worktreeId={worktree.id} /> : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const configured = configuredCommands(commandRead).map((command) =>
    commandItem(command, 'configured'),
  );
  const removed =
    commandRead?.status === 'configured'
      ? commandRead.removedCommands.map((command) => commandItem(command, 'removed'))
      : [];
  const commands = [...configured, ...removed];
  const selected = commands.find((command) => command.name === selectedId) ?? commands[0] ?? null;

  return (
    <>
      <CommandList
        sections={[
          { commands: configured },
          ...(removed.length > 0
            ? [{ title: workbenchCopy.commandRemovedSection, commands: removed }]
            : []),
        ]}
        selected={selected}
        onSelect={selectCommand}
        loading={commandsQuery.isPending}
        runCommand={runCommand}
        stopCommand={stopCommand}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {selected && worktree ? (
          <CommandDetail command={selected} worktreeId={worktree.id} />
        ) : null}
      </div>
    </>
  );
}

function CommandList({
  sections,
  selected,
  onSelect,
  loading = false,
  runCommand,
  stopCommand,
}: {
  readonly sections: readonly {
    readonly title?: string | undefined;
    readonly commands: readonly CommandListItem[];
  }[];
  readonly selected: CommandListItem | null;
  readonly onSelect: (commandName: string) => void;
  readonly loading?: boolean | undefined;
  readonly runCommand: ReturnType<typeof useRunCommandMutation>;
  readonly stopCommand: ReturnType<typeof useStopCommandMutation>;
}) {
  const hasCommands = sections.some((section) => section.commands.length > 0);

  return (
    <div className="flex w-52 flex-none flex-col overflow-auto border-r border-line/12 p-2">
      {loading ? (
        <p className="px-2 pt-1 font-mono text-[11px] text-fg-subtle opacity-55">
          {workbenchCopy.commandsLoading}
        </p>
      ) : !hasCommands ? (
        <p className="px-2 pt-1 font-mono text-[11px] text-fg-subtle opacity-55">
          {workbenchCopy.emptyCommands}
        </p>
      ) : (
        sections.map((section, sectionIndex) =>
          section.commands.length > 0 ? (
            <div key={section.title ?? `commands-${sectionIndex}`} className="mb-1 last:mb-0">
              {section.title && (
                <p className="px-2 pb-1 pt-2 font-mono text-[10px] tracking-widest text-fg-subtle uppercase opacity-70">
                  {section.title}
                </p>
              )}
              {section.commands.map((command) => (
                <CommandListRow
                  key={`${command.presentation}:${command.name}`}
                  command={command}
                  selected={command.name === selected?.name}
                  onSelect={onSelect}
                  runCommand={runCommand}
                  stopCommand={stopCommand}
                />
              ))}
            </div>
          ) : null,
        )
      )}
    </div>
  );
}

function CommandListRow({
  command,
  selected,
  onSelect,
  runCommand,
  stopCommand,
}: {
  readonly command: CommandListItem;
  readonly selected: boolean;
  readonly onSelect: (commandName: string) => void;
  readonly runCommand: ReturnType<typeof useRunCommandMutation>;
  readonly stopCommand: ReturnType<typeof useStopCommandMutation>;
}) {
  const canRun = command.presentation === 'configured' && command.status !== 'running';
  const canStop = command.status === 'running';
  const showAction = canRun || canStop;
  const runAction = () => {
    onSelect(command.name);
    if (canStop) {
      stopCommand.mutate(command.name);
      return;
    }
    runCommand.mutate(command.name);
  };

  return (
    <div
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 transition-colors ${
        selected ? 'bg-white/8' : 'hover:bg-white/4'
      }`}
    >
      {showAction ? (
        <button
          type="button"
          onClick={runAction}
          disabled={runCommand.isPending || stopCommand.isPending}
          title={`${canStop ? 'Stop' : 'Run'} ${command.name}`}
          aria-label={`${canStop ? 'Stop' : 'Run'} ${command.name}`}
          className="grid size-5 flex-none place-items-center rounded-md border border-line/20 text-fg-subtle transition-colors hover:border-blue/45 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
        >
          {canStop ? <Square size={9} /> : <Play size={9} />}
        </button>
      ) : (
        <span className="size-5 flex-none" />
      )}
      <button
        type="button"
        onClick={() => onSelect(command.name)}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <AttentionDot state={attentionForCommandStatus(command.status)} />
        <span className="truncate font-mono text-[12px] text-fg">{command.name}</span>
        {command.presentation === 'removed' && (
          <span className="rounded-md border border-amber/24 bg-amber/10 px-1.5 py-px font-mono text-[9.5px] text-amber">
            {workbenchCopy.commandRemovedMarker}
          </span>
        )}
      </button>
    </div>
  );
}

function CommandDetail({ command, worktreeId }: { command: CommandListItem; worktreeId: number }) {
  const logMetadataQuery = useCommandLogMetadataQuery(worktreeId, command.name);
  const restartCommand = useRestartCommandMutation(worktreeId);
  const runCommand = useRunCommandMutation(worktreeId);
  const stopCommand = useStopCommandMutation(worktreeId);
  const mutationError = restartCommand.error ?? runCommand.error ?? stopCommand.error;
  const latestRun = logMetadataQuery.data?.latestRun;
  const canRun = command.presentation === 'configured' && command.status !== 'running';
  const canRestart = command.presentation === 'configured';
  const canStop = command.status === 'running';

  return (
    <>
      <div className="flex h-11 flex-none items-center gap-2.5 border-b border-line/12 px-3.5">
        <AttentionDot state={attentionForCommandStatus(command.status)} />
        <span className="font-mono text-[12px] text-fg">{command.name}</span>
        <span className="font-mono text-[10.5px] text-fg-subtle">{command.status}</span>
        {command.presentation === 'removed' && (
          <span className="rounded-md border border-amber/24 bg-amber/10 px-1.5 py-px font-mono text-[10px] text-amber">
            {workbenchCopy.commandRemovedMarker}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
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
          {canRestart && (
            <button
              type="button"
              onClick={() => restartCommand.mutate(command.name)}
              disabled={restartCommand.isPending}
              title={`Restart ${command.name}`}
              className="grid size-6 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
            >
              <RotateCcw size={12} />
            </button>
          )}
          {(canRun || canStop) && (
            <button
              type="button"
              onClick={() =>
                canStop ? stopCommand.mutate(command.name) : runCommand.mutate(command.name)
              }
              disabled={runCommand.isPending || stopCommand.isPending}
              title={`${canStop ? 'Stop' : 'Run'} ${command.name}`}
              className="grid size-6 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
            >
              {canStop ? <Square size={12} /> : <Play size={12} />}
            </button>
          )}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
        {command.presentation === 'removed' && (
          <p className="mb-3 rounded-md border border-amber/18 bg-amber/8 px-2.5 py-2 text-[12px] text-fg-muted">
            {workbenchCopy.commandRemovedDetail}
          </p>
        )}
        {command.presentation === 'managed' && (
          <p className="mb-3 rounded-md border border-line/16 bg-white/4 px-2.5 py-2 text-[12px] text-fg-muted">
            {workbenchCopy.commandManagedDetail}
          </p>
        )}
        {mutationError && (
          <p className="mb-3 rounded-md border border-error/20 bg-error/8 px-2.5 py-2 text-[12px] text-error">
            {formatRuntimeError(mutationError)}
          </p>
        )}
        {logMetadataQuery.error ? (
          <p className="font-mono text-[11.5px] text-error">
            {formatRuntimeError(logMetadataQuery.error)}
          </p>
        ) : logMetadataQuery.isPending ? (
          <p className="font-mono text-[11.5px] text-fg-subtle opacity-70">
            {workbenchCopy.commandsLoading}
          </p>
        ) : latestRun?.hasPtyProcess ? (
          <CommandLogTerminal
            worktreeId={worktreeId}
            commandName={command.name}
            latestRunId={latestRun.id}
          />
        ) : latestRun ? (
          <CommandRunMetadataState
            status={latestRun.status}
            hasPtyProcess={latestRun.hasPtyProcess}
            diagnosticReason={latestRun.diagnostic?.reason ?? null}
            diagnosticDetail={latestRun.diagnostic?.detail ?? null}
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <p className="font-mono text-[11.5px] text-fg-subtle opacity-70">
              {workbenchCopy.commandIdleDetail}
            </p>
          </div>
        )}
      </div>
    </>
  );
}

function CommandLogTerminal({
  worktreeId,
  commandName,
  latestRunId,
}: {
  readonly worktreeId: number;
  readonly commandName: string;
  readonly latestRunId: number;
}) {
  const { transport, streamKey, state, rendererWarning, setRendererWarning } = useCommandLogStream({
    worktreeId,
    commandName,
    latestRunId,
  });
  const display = commandLogDisplayState({ state, rendererWarning });
  const notice = display.notice ?? (display.kind === 'errored' ? { summary: display.label } : null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-line/14">
        <XtermSurface
          key={streamKey}
          transport={transport}
          initiallyInteractive={false}
          className="isagi-xterm isagi-xterm-edge h-full min-h-0"
          onRendererWarning={setRendererWarning}
        />
        {notice ? (
          <div className="pointer-events-none absolute top-2 right-2 left-2 z-10 max-w-2xl rounded-md border border-line/18 bg-canvas/88 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-fg-muted shadow-soft backdrop-blur-sm">
            <span>{notice.summary}</span>
            {notice.detail ? (
              <span className="ml-2 opacity-65">
                {workbenchCopy.commandRunDiagnosticDetailLabel}: {notice.detail}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CommandRunMetadataState({
  status,
  hasPtyProcess,
  diagnosticReason,
  diagnosticDetail,
}: {
  readonly status: Exclude<CommandStatus, 'idle'>;
  readonly hasPtyProcess: boolean;
  readonly diagnosticReason: CommandRunDiagnosticReason | null;
  readonly diagnosticDetail: string | null;
}) {
  const primary = diagnosticReason
    ? workbenchCopy.commandRunDiagnostic[diagnosticReason]
    : hasPtyProcess
      ? workbenchCopy.commandOutputWillStream
      : workbenchCopy.commandOutputStreamingPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-3 rounded-md border border-line/14 bg-black/12 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <AttentionDot state={attentionForCommandStatus(status)} />
        <p className="font-mono text-[11.5px] text-fg-muted">{primary}</p>
      </div>
      <p className="font-mono text-[10.5px] text-fg-subtle opacity-65">
        {workbenchCopy.commandOutputStatusCurrent}
      </p>
      {diagnosticDetail && (
        <div className="rounded-md border border-line/16 bg-black/14 p-2.5">
          <p className="mb-1 font-mono text-[10px] text-fg-subtle opacity-65">
            {workbenchCopy.commandRunDiagnosticDetailLabel}
          </p>
          <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">
            {diagnosticDetail}
          </p>
        </div>
      )}
    </div>
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

function CommandDiagnosticPanel({
  title,
  body,
  diagnostic,
  onRefresh,
}: {
  readonly title: string;
  readonly body: string;
  readonly diagnostic: string;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="flex-none p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle size={15} className="text-error" />
        <h2 className="font-mono text-[12px] text-fg">{title}</h2>
      </div>
      <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-fg-muted">{body}</p>
      <pre className="mt-4 max-h-32 overflow-auto rounded-md border border-line/18 bg-black/15 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-subtle">
        {diagnostic}
      </pre>
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

function commandItem(command: CommandSummary, presentation: CommandPresentation): CommandListItem {
  return { ...command, presentation };
}

function attentionForCommandStatus(status: CommandStatus): AttentionState {
  if (status === 'running') return 'working';
  if (status === 'failed') return 'error';
  return 'idle';
}
