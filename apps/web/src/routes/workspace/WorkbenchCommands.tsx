import { AlertTriangle, Play, RefreshCw, RotateCcw, Square } from 'lucide-react';

import type { CommandRunStatus, CommandSummary, WorktreeCommandsOutput } from '@isagi/contracts';

import { AttentionDot } from '../../components/AttentionDot.js';
import { workbenchCopy } from '../../copy/index.js';
import { useRuntimeLocality } from '../../lib/runtime/locality.js';
import {
  commandAffordances,
  commandAttentionState,
  commandDetailNotice,
  type CommandDetailNotice as CommandDetailNoticeValue,
  type CommandNoticeTone,
  type CommandPresentation,
} from '../../lib/workspace/command-attention.js';
import { commandLogDisplayState } from '../../lib/workspace/command-log/display.js';
import { useCommandLogStream } from '../../lib/workspace/command-log/stream.js';
import { commandEndpointsPresentation } from '../../lib/workspace/command-ports.js';
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
import { CommandEndpoints } from './CommandEndpoints.js';
import { XtermSurface } from './XtermSurface.js';

type CommandListItem = CommandSummary & {
  readonly presentation: CommandPresentation;
};

/**
 * The commands master-detail shown inside the workbench drawer. Commands are
 * processes you *watch* (logs, ports, run/stop); interactive shells live on the
 * canvas as terminal surfaces, not here.
 */
export function CommandsView() {
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
    const { path, message } = commandRead.diagnostic;

    // Nothing to list, so the diagnostic *is* the content. Without this branch a
    // broken config with no live commands would render an empty drawer, which
    // says nothing about why the commands are gone.
    if (managedCommands.length === 0) {
      return (
        <CommandDiagnosticState
          title={workbenchCopy.commandConfigDiagnosticTitle}
          body={workbenchCopy.commandConfigDiagnosticBody}
          diagnostic={`${path}\n${message}`}
          onRefresh={() => void commandsQuery.refetch()}
        />
      );
    }

    // With commands to show, the drawer keeps its ordinary master-detail shape.
    // The old full-width panel and the `runtime-managed commands` heading are
    // gone: the heading named an internal concept no user could place, and the
    // panel rebuilt the whole layout for a state the badge and the detail notice
    // already carry. The parse error survives as the notice's diagnostic detail,
    // because a user who cannot see it cannot fix it.
    const selected =
      managedCommands.find((command) => command.name === selectedId) ?? managedCommands[0] ?? null;

    return (
      <>
        <CommandList
          sections={[{ commands: managedCommands }]}
          selected={selected}
          onSelect={selectCommand}
          runCommand={runCommand}
          stopCommand={stopCommand}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <CommandDetail
              command={selected}
              worktreeId={worktree.id}
              // Joined for prose rather than for a `pre`: the notice renders it as
              // one inline run, where a bare newline would collapse into a space
              // mid-sentence and read as a typo.
              configDiagnostic={`${path} — ${message}`}
              onRefreshCatalog={() => void commandsQuery.refetch()}
            />
          ) : null}
        </div>
      </>
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
  const { canRun, canStop } = commandAffordances(command.status, command.presentation);
  // The row has space for one affordance, so it carries the likelier intent and
  // the detail header carries the full set. Run wins wherever it is offered: a
  // suspended command is far more often resumed than abandoned, and Stop is
  // never more than one click further on. A running command has no Run, so the
  // row still shows Stop exactly as it always did.
  const rowAction = canRun ? 'run' : canStop ? 'stop' : null;
  const runAction = () => {
    onSelect(command.name);
    if (rowAction === 'stop') {
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
      {rowAction ? (
        <button
          type="button"
          onClick={runAction}
          disabled={runCommand.isPending || stopCommand.isPending}
          title={`${rowAction === 'stop' ? 'Stop' : 'Run'} ${command.name}`}
          aria-label={`${rowAction === 'stop' ? 'Stop' : 'Run'} ${command.name}`}
          className="grid size-5 flex-none place-items-center rounded-md border border-line/20 text-fg-subtle transition-colors hover:border-blue/45 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
        >
          {rowAction === 'stop' ? <Square size={9} /> : <Play size={9} />}
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
        <AttentionDot state={commandAttentionState(command.status)} />
        <span className="truncate font-mono text-[12px] text-fg">{command.name}</span>
        {command.presentation !== 'configured' && (
          <span className="rounded-md border border-amber/24 bg-amber/10 px-1.5 py-px font-mono text-[9.5px] text-amber">
            {command.presentation === 'removed'
              ? workbenchCopy.commandRemovedMarker
              : workbenchCopy.commandConfigMarker}
          </span>
        )}
      </button>
    </div>
  );
}

function CommandDetail({
  command,
  worktreeId,
  configDiagnostic = null,
  onRefreshCatalog,
}: {
  readonly command: CommandListItem;
  readonly worktreeId: number;
  /** The parse error behind a `managed` presentation, if there is one. */
  readonly configDiagnostic?: string | null | undefined;
  /** Offered only for `managed`, where a fix happens on disk and needs a re-read. */
  readonly onRefreshCatalog?: (() => void) | undefined;
}) {
  const logMetadataQuery = useCommandLogMetadataQuery(worktreeId, command.name);
  const restartCommand = useRestartCommandMutation(worktreeId);
  const runCommand = useRunCommandMutation(worktreeId);
  const stopCommand = useStopCommandMutation(worktreeId);
  const mutationError = restartCommand.error ?? runCommand.error ?? stopCommand.error;
  const latestRun = logMetadataQuery.data?.latestRun;
  const locality = useRuntimeLocality();
  // The separator only earns its place when there is a toggle to separate. A
  // command that declared no ports keeps exactly the header it has today.
  const endpointsPresent = commandEndpointsPresentation(command.ports, locality) !== null;
  const { canRun, canStop, canRestart } = commandAffordances(command.status, command.presentation);
  const notice = commandDetailNotice({
    status: command.status,
    presentation: command.presentation,
    runDiagnostic: latestRun?.diagnostic ?? null,
    configDiagnostic,
  });

  return (
    <>
      <div className="flex h-11 flex-none items-center gap-2.5 border-b border-line/12 px-3.5">
        <AttentionDot state={commandAttentionState(command.status)} />
        <span className="font-mono text-[12px] text-fg">{command.name}</span>
        <span className="font-mono text-[10.5px] text-fg-subtle">{command.status}</span>
        {command.presentation !== 'configured' && (
          <span className="rounded-md border border-amber/24 bg-amber/10 px-1.5 py-px font-mono text-[10px] text-amber">
            {command.presentation === 'removed'
              ? workbenchCopy.commandRemovedMarker
              : workbenchCopy.commandConfigLabel}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {/* Endpoints sit in the header's action cluster but are separated from
              it by a rule. Restart and Stop act on the process; this reveals
              information, and an undifferentiated row of grey squares would make
              the first thing a user tries with it an action on their server. */}
          <CommandEndpoints commandName={command.name} ports={command.ports} locality={locality} />
          {endpointsPresent && <span className="h-4 w-px flex-none bg-line/26" />}
          {onRefreshCatalog && (
            <button
              type="button"
              onClick={onRefreshCatalog}
              title={workbenchCopy.refreshCommands}
              aria-label={workbenchCopy.refreshCommands}
              className="grid size-6 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg"
            >
              <RefreshCw size={12} />
            </button>
          )}
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
          {/* Two buttons, not one. Until `suspended` existed these were mutually
              exclusive — a command was either startable or stoppable — and one
              button that flipped its icon was enough. A suspended command is
              both: Run resumes it now, Stop clears the resume intent. Collapsing
              them would silently drop whichever one lost. */}
          {canRun && (
            <button
              type="button"
              onClick={() => runCommand.mutate(command.name)}
              disabled={runCommand.isPending || stopCommand.isPending}
              title={`Run ${command.name}`}
              aria-label={`Run ${command.name}`}
              className="grid size-6 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Play size={12} />
            </button>
          )}
          {canStop && (
            <button
              type="button"
              onClick={() => stopCommand.mutate(command.name)}
              disabled={runCommand.isPending || stopCommand.isPending}
              title={`Stop ${command.name}`}
              aria-label={`Stop ${command.name}`}
              className="grid size-6 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Square size={12} />
            </button>
          )}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
        {notice && <CommandDetailNotice notice={notice} />}
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

/**
 * The one notice a command's detail pane shows. Which notice that is — and that
 * there is never a second one stacked under it — is decided by
 * `commandDetailNotice`; this component only paints it.
 */
function CommandDetailNotice({ notice }: { readonly notice: CommandDetailNoticeValue }) {
  return (
    <div className={`mb-3 rounded-md border px-2.5 py-2 ${noticeTone(notice.tone)}`}>
      <p className="text-[12px] leading-relaxed text-fg-muted">{notice.text}</p>
      {notice.detail && (
        <p className="mt-1.5 font-mono text-[10.5px] leading-relaxed text-fg-subtle opacity-75">
          {workbenchCopy.commandRunDiagnosticDetailLabel}: {notice.detail}
        </p>
      )}
    </div>
  );
}

function noticeTone(tone: CommandNoticeTone): string {
  switch (tone) {
    case 'waiting':
      return 'border-waiting/18 bg-waiting/8';
    case 'warning':
      return 'border-amber/18 bg-amber/8';
    case 'neutral':
      return 'border-line/16 bg-white/4';
  }
}

/**
 * The run's own summary, for a run with no PTY output to show. Run diagnostics
 * are deliberately absent here: they are voiced once, by the notice band above,
 * for both PTY-linked and metadata-only runs. Saying it twice on the same screen
 * was the duplication the single-band rule exists to prevent.
 */
function CommandRunMetadataState({
  status,
  hasPtyProcess,
}: {
  readonly status: CommandRunStatus;
  readonly hasPtyProcess: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-3 rounded-md border border-line/14 bg-black/12 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <AttentionDot state={commandAttentionState(status)} />
        <p className="font-mono text-[11.5px] text-fg-muted">
          {hasPtyProcess
            ? workbenchCopy.commandOutputWillStream
            : workbenchCopy.commandOutputNotRecorded}
        </p>
      </div>
      <p className="font-mono text-[10.5px] text-fg-subtle opacity-65">
        {workbenchCopy.commandOutputStatusCurrent}
      </p>
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

function configuredCommands(output: WorktreeCommandsOutput | undefined) {
  return output?.status === 'configured' ? output.commands : [];
}

function commandItem(command: CommandSummary, presentation: CommandPresentation): CommandListItem {
  return { ...command, presentation };
}
