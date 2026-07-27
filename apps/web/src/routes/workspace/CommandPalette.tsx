import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useCallback, useMemo, useRef, useReducer, useState } from 'react';

import type { WorkflowStartContext } from '@isagi/contracts';

import { Chip } from '../../components/Chip.js';
import {
  InputFlowBody,
  InputFlowControl,
  inputFlowHasTextInput,
  inputFlowSelectableLength,
  withSelectedIndex,
  type InputFlowScreen,
} from '../../components/input-flow/index.js';
import { paletteCopy } from '../../copy/index.js';
import { useKeyboardSelection } from '../../hooks/useKeyboardSelection.js';
import { useLaunchableHarnesses } from '../../lib/control-plane/queries.js';
import { surfaceTransition, uiTransition } from '../../lib/motion.js';
import {
  buildPaletteContext,
  workflowContextFromSurfaceDetail,
} from '../../lib/palette/context.js';
import {
  commandForWorkbenchActionId,
  resolveStateCommand,
  runPaletteEffects,
} from '../../lib/palette/effects.js';
import { assembleEntries } from '../../lib/palette/entries.js';
import { commandStepToInputFlowScreen } from '../../lib/palette/input-flow.js';
import {
  currentStep,
  initialPaletteState,
  isBusy,
  paletteReducer,
} from '../../lib/palette/machine.js';
import {
  commandForEntryId,
  defaultOptionIndex,
  filterEntries,
  recencyView,
} from '../../lib/palette/model.js';
import { outcomeActions } from '../../lib/palette/outcome.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import type { ArgSpec, PaletteEntry, ReviewChoice } from '../../lib/palette/types.js';
import {
  workflowFailurePresentation,
  workflowStartFailureContent,
} from '../../lib/palette/workflow-failure.js';
import { isPlatformModifierShortcut, modKey } from '../../lib/platform.js';
import { restoreActivePaneFocus } from '../../lib/workspace/activation.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import {
  useStartWorkflowMutation,
  useSurfaceDetailQuery,
  useWorkflowDescriptorsQuery,
} from '../../lib/workspace/queries.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import { selectRootRunForSurface, useWorkflowRunStore } from '../../lib/workspace/workflow-runs.js';
import { EntryList, OutcomePanel, RunningPanel, Tip } from './CommandPaletteViews.js';
import { WorkflowInputFlow, type WorkflowInputAnswers } from './WorkflowInputFlow.js';

function inputFlowDefaultIndex(spec: ArgSpec | null, screen: InputFlowScreen) {
  if (screen.kind === 'select' || screen.kind === 'combo') {
    return spec ? defaultOptionIndex(spec, screen.options) : screen.options.length > 0 ? 0 : null;
  }
  if (screen.kind === 'text') {
    return null;
  }
  if (screen.kind === 'path' && screen.stale) {
    return null;
  }
  return inputFlowSelectableLength(screen) > 0 ? 0 : null;
}

export function CommandPalette() {
  const open = usePaletteStore((state) => state.open);
  const autostartEntryId = usePaletteStore((state) => state.autostartEntryId);
  const autostartValues = usePaletteStore((state) => state.autostartValues);
  const recents = usePaletteStore((state) => state.recents);
  const openPalette = usePaletteStore((state) => state.openPalette);
  const closePalette = usePaletteStore((state) => state.closePalette);
  const pushRecent = usePaletteStore((state) => state.pushRecent);

  const { projects, activeWorktreeId, activeSurfaceByWorktreeId } = useWorkspace();
  const activePaneBySurfaceId = useWorkspaceStore((state) => state.activePaneBySurfaceId);
  const launchableHarnesses = useLaunchableHarnesses();
  const baseCtx = useMemo(
    () =>
      buildPaletteContext(projects, activeWorktreeId, {
        launchableHarnesses,
        activeSurfaceByWorktreeId,
        activePaneBySurfaceId,
      }),
    [
      projects,
      activeWorktreeId,
      launchableHarnesses,
      activeSurfaceByWorktreeId,
      activePaneBySurfaceId,
    ],
  );
  const activeSurfaceWorkflowSummary = useWorkflowRunStore(
    selectRootRunForSurface(baseCtx.activeSurface?.id),
  );
  const activeSurfaceDetail = useSurfaceDetailQuery(baseCtx.activeSurface?.id ?? null, {
    enabled: open && baseCtx.activeSurface !== null,
  });
  const workflowLaunchContext = useMemo(
    (): WorkflowStartContext | null =>
      baseCtx.activeWorktree && baseCtx.activeSurface && activeSurfaceDetail.data
        ? workflowContextFromSurfaceDetail({
            worktreeId: baseCtx.activeWorktree.id,
            surfaceId: baseCtx.activeSurface.id,
            activePaneId: baseCtx.activePaneId,
            detail: activeSurfaceDetail.data,
          })
        : null,
    [activeSurfaceDetail.data, baseCtx.activePaneId, baseCtx.activeSurface, baseCtx.activeWorktree],
  );
  const workflowDescriptors = useWorkflowDescriptorsQuery(workflowLaunchContext, { enabled: open });
  // A whole-list discovery failure is derived only from the current enabled query
  // state: no launch context or a merely-pending query yields no failure row; a
  // terminal error (including a failed refetch over stale data) overrides the
  // cached descriptors via `assembleEntries` suppression.
  const workflowFailure = useMemo(
    () =>
      workflowLaunchContext !== null && workflowDescriptors.isError
        ? workflowFailurePresentation(workflowDescriptors.error)
        : undefined,
    [workflowLaunchContext, workflowDescriptors.isError, workflowDescriptors.error],
  );
  const ctx = useMemo(
    () =>
      buildPaletteContext(projects, activeWorktreeId, {
        launchableHarnesses,
        activeSurfaceByWorktreeId,
        activePaneBySurfaceId,
        workflowDescriptors: workflowDescriptors.data?.workflows,
        activeSurfaceWorkflowSummary,
        workflowFailure,
      }),
    [
      projects,
      activeWorktreeId,
      launchableHarnesses,
      activeSurfaceByWorktreeId,
      activePaneBySurfaceId,
      workflowDescriptors.data?.workflows,
      activeSurfaceWorkflowSummary,
      workflowFailure,
    ],
  );
  const allEntries = useMemo(() => assembleEntries(ctx), [ctx]);

  const [machine, send] = useReducer(paletteReducer, initialPaletteState);
  const [workflowFormEntryId, setWorkflowFormEntryId] = useState<string | null>(null);
  const startWorkflowMutation = useStartWorkflowMutation();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Live highlight index for event-time handlers (defined before the selection
  // hook); render reads `selection.selectedIndex` directly.
  const selectedIndexRef = useRef<number | null>(null);
  const seenEffectIds = useRef(new Set<number>());
  const pathSuggestTimer = useRef<number | null>(null);
  const lastOpenRequest = useRef<{
    readonly entryId: string | null;
    readonly values: typeof autostartValues;
  } | null>(null);

  const closeCurrentPalette = useCallback(() => {
    send({ type: 'closed' });
  }, []);

  useEffect(() => {
    if (!open || machine.kind !== 'closed' || lastOpenRequest.current === null) {
      return;
    }
    closePalette();
    restoreActivePaneFocus();
  }, [closePalette, machine.kind, open]);

  // Global hotkeys: Mod+K toggles the palette, Mod+N opens Add project.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPlatformModifierShortcut(event)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        if (open) {
          closeCurrentPalette();
        } else {
          openPalette();
        }
      } else if (key === 'n') {
        event.preventDefault();
        openPalette('add-project');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, openPalette, closeCurrentPalette]);

  // Reset on open; jump straight into a command flow when autostarted.
  useEffect(() => {
    if (!open) {
      setWorkflowFormEntryId(null);
      lastOpenRequest.current = null;
      if (machine.kind !== 'closed') {
        send({ type: 'closed' });
      }
      return;
    }

    const openRequest = { entryId: autostartEntryId, values: autostartValues };
    if (
      lastOpenRequest.current?.entryId === openRequest.entryId &&
      lastOpenRequest.current.values === openRequest.values
    ) {
      return;
    }

    lastOpenRequest.current = openRequest;
    const autostart =
      commandForEntryId(allEntries, autostartEntryId) ??
      commandForWorkbenchActionId(autostartEntryId);
    if (!autostart?.command) {
      send({ type: 'opened' });
      return;
    }
    send({
      type: 'autostart',
      entryId: autostart.entryId,
      command: autostart.command,
      ctx,
      values: { ...(autostart.values ?? {}), ...autostartValues },
    });
  }, [open, machine.kind, autostartEntryId, autostartValues, allEntries, ctx]);

  const command = useMemo(() => resolveStateCommand(machine, allEntries), [machine, allEntries]);
  const args = command?.args ?? [];
  const spec = currentStep(command, machine);
  const query = machine.kind === 'search' || machine.kind === 'step' ? machine.query : '';
  const commandError =
    machine.kind === 'search' || machine.kind === 'step' ? machine.inlineError : null;

  useEffect(() => {
    if (machine.kind !== 'step' || (command && spec)) {
      return;
    }
    send({
      type: 'flow-failed',
      content: {
        title: paletteCopy.outcome.commandUnavailableTitle,
        body: paletteCopy.outcome.commandUnavailableBody,
      },
    });
  }, [command, machine.kind, spec]);

  // A command's async run (or a workflow launch) is in flight. The machine stays
  // in search/step while the run effect resolves, so without this the palette
  // would keep rendering the frozen list/wizard with no sign of progress.
  const running = isBusy(machine) || startWorkflowMutation.isPending;

  const view = useMemo(() => {
    if (running) {
      return {
        kind: 'running' as const,
        content: command?.running ?? { title: paletteCopy.running.title },
      };
    }
    if (machine.kind === 'result') {
      return { kind: 'result' as const, content: machine.content };
    }
    if (machine.kind === 'error') {
      return { kind: 'error' as const, content: machine.content };
    }
    if (workflowFormEntryId) {
      const entry = allEntries.find((candidate) => candidate.id === workflowFormEntryId);
      if (entry?.workflow) {
        return { kind: 'workflow-form' as const, entry, workflow: entry.workflow };
      }
    }
    if (machine.kind === 'step' && command && spec) {
      // The highlight index is owned by the selection hook (wired below) and
      // injected at render via `withSelectedIndex`; the shape is selection-free.
      return {
        kind: 'input-flow' as const,
        screen: commandStepToInputFlowScreen({
          spec,
          stepData: machine.stepData,
          query: machine.query,
        }),
      };
    }

    const searchQuery = machine.kind === 'search' ? machine.query : '';
    const items = searchQuery
      ? filterEntries(allEntries, searchQuery)
      : recencyView(allEntries, recents);
    return { kind: 'list' as const, items };
  }, [running, machine, workflowFormEntryId, allEntries, command, spec, recents]);
  const acceptsInput =
    !running &&
    view.kind !== 'workflow-form' &&
    view.kind !== 'input-flow' &&
    (machine.kind === 'search' || machine.kind === 'step');

  useEffect(() => {
    runPaletteEffects(machine.effects, {
      allEntries,
      ctx,
      send,
      pushRecent,
      pathSuggestTimer,
      seenEffectIds,
    });
  }, [machine.effects, allEntries, ctx, pushRecent]);

  const renderedLength =
    view.kind === 'running'
      ? 0
      : view.kind === 'input-flow'
        ? inputFlowSelectableLength(view.screen)
        : view.kind === 'list'
          ? view.items.length
          : view.kind === 'result' || view.kind === 'error'
            ? outcomeActions(view.content).length
            : 0;
  const selectableLength = renderedLength;
  const baseViewKey = running
    ? 'running'
    : machine.kind === 'step'
      ? `wizard-${machine.flow.stepIndex}:${query}`
      : machine.kind === 'search'
        ? query
          ? `search:${query}`
          : 'recent'
        : machine.kind === 'result' || machine.kind === 'error'
          ? machine.viewKey
          : 'closed';
  const defaultIndex =
    view.kind === 'running'
      ? null
      : view.kind === 'input-flow'
        ? inputFlowDefaultIndex(spec, view.screen)
        : view.kind === 'workflow-form'
          ? null
          : 0;
  const viewKey = `${baseViewKey}:${selectableLength}:${defaultIndex ?? 'none'}`;
  const panelKey = running
    ? 'running'
    : view.kind === 'workflow-form'
      ? `workflow-form:${view.entry.id}`
      : machine.kind === 'step' && view.kind === 'input-flow' && view.screen.kind === 'path'
        ? `path-${machine.flow.stepIndex}`
        : viewKey;

  // Keep the right element focused so the panel's key handler receives keys:
  // the search input for list/text-bearing steps, the panel itself for screens
  // with no text input (review steps, outcomes). input-flow controls that own a
  // text input autofocus themselves; the workflow form manages its own focus.
  useEffect(() => {
    if (!open || running || view.kind === 'workflow-form') {
      return;
    }
    if (acceptsInput) {
      inputRef.current?.focus();
      return;
    }
    if (view.kind === 'input-flow' && inputFlowHasTextInput(view.screen)) {
      return;
    }
    panelRef.current?.focus();
  }, [open, running, acceptsInput, view, viewKey]);

  const startWorkflowEntry = (entry: PaletteEntry, answers: WorkflowInputAnswers) => {
    if (!entry.workflow || !workflowLaunchContext) {
      send({
        type: 'flow-failed',
        entryId: entry.id,
        content: {
          title: paletteCopy.outcome.commandUnavailableTitle,
          body: paletteCopy.outcome.commandUnavailableBody,
        },
      });
      return;
    }

    startWorkflowMutation.mutate(
      {
        workflowKey: entry.workflow.workflowKey,
        variables: answers,
        context: workflowLaunchContext,
      },
      {
        onSuccess: () => {
          pushRecent(entry.id);
          closeCurrentPalette();
        },
        onError: (error) => {
          setWorkflowFormEntryId(null);
          send({
            type: 'flow-failed',
            entryId: entry.id,
            content: workflowStartFailureContent(error),
          });
        },
      },
    );
  };

  const runEntry = (entry: PaletteEntry) => {
    if (entry.disabled) {
      return;
    }
    if (entry.workflow) {
      if (startWorkflowMutation.isPending) {
        return;
      }
      const questions = entry.workflow.manifest.inputs ?? [];
      if (questions.length === 0) {
        startWorkflowEntry(entry, {});
        return;
      }
      setWorkflowFormEntryId(entry.id);
      return;
    }
    send({ type: 'activate-entry', entry, ctx });
  };

  const acceptValue = (value: string, label: string, payload?: unknown) => {
    if (!command) {
      return;
    }
    send({ type: 'accept-value', command, ctx, value, label, payload });
  };

  const acceptOption = (option: {
    readonly value: string;
    readonly label?: string | undefined;
    readonly payload?: unknown;
  }) => {
    acceptValue(option.value, option.label ?? option.value, option.payload);
  };

  const acceptReviewChoice = (choice: {
    readonly value: string;
    readonly label: string;
    readonly hint?: string | undefined;
    readonly intent?: ReviewChoice['intent'] | undefined;
    readonly payload?: unknown;
  }) => {
    if (!command) {
      return;
    }
    send({
      type: 'accept-review-choice',
      command,
      ctx,
      choice: {
        value: choice.value,
        label: choice.label,
        ...(choice.hint !== undefined ? { hint: choice.hint } : {}),
        ...(choice.intent !== undefined ? { intent: choice.intent } : {}),
        ...(choice.payload !== undefined ? { payload: choice.payload } : {}),
      },
    });
  };

  const acceptText = () => {
    if (view.kind === 'input-flow' && view.screen.kind === 'text') {
      acceptValue(view.screen.value, view.screen.value);
    }
  };

  const acceptPath = () => {
    if (view.kind !== 'input-flow' || view.screen.kind !== 'path') {
      return;
    }
    // Shell-style: Enter fills the input with the highlighted directory rather
    // than submitting. Press it again (buffer unchanged since the fill) to
    // commit, or type "/" to drill into the filled path and keep navigating.
    if (
      machine.kind === 'step' &&
      view.screen.value &&
      view.screen.value === machine.lastFilledPath
    ) {
      acceptValue(view.screen.value, view.screen.value);
      return;
    }
    const index = selectedIndexRef.current;
    const highlighted = index === null ? undefined : view.screen.suggestions[index];
    if (!view.screen.stale && highlighted && highlighted.path !== view.screen.value) {
      send({ type: 'fill-path', path: highlighted.path });
      return;
    }
    if (view.screen.value) {
      acceptValue(view.screen.value, view.screen.value);
    }
  };

  const activate = () => {
    if (running) {
      return;
    }
    const index = selectedIndexRef.current;
    if (view.kind === 'list') {
      const entry = index === null ? undefined : view.items[index];
      if (entry) {
        runEntry(entry);
      }
    } else if (
      view.kind === 'input-flow' &&
      (view.screen.kind === 'select' || view.screen.kind === 'combo')
    ) {
      const option = index === null ? undefined : view.screen.options[index];
      if (option) {
        acceptOption(option);
      }
    } else if (view.kind === 'input-flow' && view.screen.kind === 'path') {
      acceptPath();
    } else if (view.kind === 'input-flow' && view.screen.kind === 'review') {
      const choice = index === null ? undefined : view.screen.content?.choices[index];
      if (choice) {
        acceptReviewChoice(choice);
      }
    } else if (view.kind === 'result' || view.kind === 'error') {
      const action = outcomeActions(view.content)[index ?? 0];
      if (action) {
        send({ type: 'outcome-action', value: action.value });
      }
    } else {
      acceptText();
    }
  };

  const back = () => {
    send({ type: 'back', command: command ?? undefined, ctx });
  };

  // Tab fills the buffer with the highlighted directory without submitting, so
  // Enter afterwards commits it. Path-step only.
  const fillPath = () => {
    if (view.kind !== 'input-flow' || view.screen.kind !== 'path' || view.screen.stale) {
      return;
    }
    const index = selectedIndexRef.current;
    const highlighted = index === null ? undefined : view.screen.suggestions[index];
    if (highlighted) {
      send({ type: 'fill-path', path: highlighted.path });
    }
  };

  // One selection engine for every navigable view (command list, input-flow
  // step, outcome actions). The workflow form drives its own copy of this hook.
  const selection = useKeyboardSelection({
    length: selectableLength,
    snapKey: viewKey,
    defaultIndex,
    query,
    capabilities: {
      back: !running && view.kind !== 'workflow-form',
      backOnEmptyQuery: !running && command != null && view.kind !== 'workflow-form',
      fill: !running && view.kind === 'input-flow' && view.screen.kind === 'path',
    },
    handlers: { onAccept: activate, onBack: back, onFill: fillPath },
  });
  selectedIndexRef.current = selection.selectedIndex;
  const sel = selection.selectedIndex;

  const crumbs =
    command && machine.kind === 'step'
      ? args.slice(0, machine.flow.stepIndex).flatMap((arg) => {
          if (
            arg.kind === 'select' &&
            (arg.skip?.(ctx, machine.flow.values, machine.flow.payloads) ?? false)
          ) {
            return [];
          }

          const label = machine.flow.labels[arg.key];
          return label?.trim() ? [{ key: arg.key, label }] : [];
        })
      : [];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={uiTransition}
          onPointerDown={(event) => {
            // While a run is in flight the palette is locked to its progress
            // state; an outside click must not abandon the visible work.
            if (running) {
              return;
            }
            if (event.target === event.currentTarget) {
              closeCurrentPalette();
            }
          }}
          className="fixed inset-0 z-50 flex justify-center bg-scrim/45 px-4 pt-[14vh] backdrop-blur-sm"
        >
          {/* No `layout` here: it animates every height change (drilling paths,
              filtering commands) on the expo curve and scale-distorts the
              contents mid-tween — that was the wiggle. The surface is top-anchored
              (scrim `pt-[14vh]`), so without the tween it just sizes to content and
              grows straight down. The open/close animation below is independent. */}
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            initial={{ opacity: 0, y: 6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.985 }}
            transition={surfaceTransition}
            onKeyDown={selection.onKeyDown}
            className="h-fit w-145 max-w-full overflow-hidden rounded-lg border border-line/30 bg-elevated/85 shadow-lift outline-none backdrop-blur-2xl"
          >
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line/16 px-4 py-3.5">
              {running ? (
                <Chip tone="command">{command?.label ?? paletteCopy.running.chip}</Chip>
              ) : view.kind === 'workflow-form' ? (
                <Chip tone="command">{view.workflow.manifest.title}</Chip>
              ) : command ? (
                <>
                  <Chip tone="command">{command.label}</Chip>
                  {crumbs.map((crumb) => (
                    <span key={crumb.key} className="flex items-center gap-1.5">
                      <span className="text-[11px] text-fg-subtle">›</span>
                      <Chip tone="crumb">{crumb.label}</Chip>
                    </span>
                  ))}
                  <span className="text-[11px] text-fg-subtle">›</span>
                </>
              ) : machine.kind === 'result' ? (
                <Chip tone="command">{paletteCopy.outcome.resultLabel}</Chip>
              ) : machine.kind === 'error' ? (
                <Chip tone="command">{paletteCopy.outcome.errorLabel}</Chip>
              ) : (
                <span className="font-mono text-[13px] text-blue">{modKey}K</span>
              )}
              {acceptsInput ? (
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => {
                    send({
                      type: 'query-changed',
                      query: event.target.value,
                      spec: spec ?? undefined,
                    });
                  }}
                  placeholder={
                    command
                      ? spec?.kind === 'combo'
                        ? paletteCopy.placeholders.chooseOrTypeName
                        : spec?.kind === 'text' || spec?.kind === 'path'
                          ? (spec.placeholder ?? paletteCopy.placeholders.typedValue)
                          : paletteCopy.placeholders.choose
                      : paletteCopy.placeholders.command
                  }
                  className="min-w-30 flex-1 bg-transparent font-sans text-[15px] text-fg outline-none placeholder:text-fg-subtle"
                />
              ) : view.kind === 'input-flow' ? (
                <InputFlowControl
                  screen={view.screen}
                  autoFocus
                  onQueryChange={(nextQuery) => {
                    send({
                      type: 'query-changed',
                      query: nextQuery,
                      spec: spec ?? undefined,
                    });
                  }}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-subtle">
                  {running
                    ? ''
                    : view.kind === 'workflow-form'
                      ? (view.workflow.manifest.description ?? view.workflow.workflowKey)
                      : paletteCopy.outcome.localFeedback}
                </span>
              )}
            </div>

            {commandError && (
              <p className="wrap-break-word whitespace-pre-wrap border-b border-error/18 bg-error/8 px-4 py-2.5 font-mono text-[11.5px] text-error">
                {commandError}
              </p>
            )}

            {running && <div aria-hidden className="command-sweep" />}

            <motion.div
              key={panelKey}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={uiTransition}
              className="max-h-[46vh] overflow-y-auto p-1.5"
            >
              {view.kind === 'running' ? (
                <RunningPanel content={view.content} />
              ) : view.kind === 'workflow-form' ? (
                <div>
                  <WorkflowInputFlow
                    questions={view.workflow.manifest.inputs ?? []}
                    disabled={startWorkflowMutation.isPending}
                    autoFocus
                    onBack={() => setWorkflowFormEntryId(null)}
                    onSubmit={(answers) => startWorkflowEntry(view.entry, answers)}
                  />
                </div>
              ) : view.kind === 'input-flow' ? (
                <InputFlowBody
                  screen={withSelectedIndex(view.screen, sel)}
                  onPick={(index) => {
                    if (view.screen.kind === 'select' || view.screen.kind === 'combo') {
                      const option = view.screen.options[index];
                      if (option) acceptOption(option);
                    } else if (view.screen.kind === 'path') {
                      if (view.screen.stale) return;
                      const suggestion = view.screen.suggestions[index];
                      if (suggestion) acceptValue(suggestion.path, suggestion.path);
                    } else if (view.screen.kind === 'review') {
                      const choice = view.screen.content?.choices[index];
                      if (choice) acceptReviewChoice(choice);
                    }
                  }}
                  onAccept={activate}
                />
              ) : view.kind === 'result' ? (
                <OutcomePanel
                  content={view.content}
                  kind="result"
                  sel={sel}
                  onAction={(value) => send({ type: 'outcome-action', value })}
                />
              ) : view.kind === 'error' ? (
                <OutcomePanel
                  content={view.content}
                  kind="error"
                  sel={sel}
                  onAction={(value) => send({ type: 'outcome-action', value })}
                />
              ) : (
                <EntryList
                  items={view.items}
                  sel={sel}
                  onPick={(index) => {
                    const entry = view.items[index];
                    if (entry) {
                      runEntry(entry);
                    }
                  }}
                />
              )}
            </motion.div>

            <Tip
              mode={
                running
                  ? 'running'
                  : view.kind === 'result' || view.kind === 'error'
                    ? 'outcome'
                    : view.kind === 'workflow-form'
                      ? 'wizard'
                      : command
                        ? view.kind === 'input-flow' && view.screen.kind === 'path'
                          ? 'path'
                          : 'wizard'
                        : 'list'
              }
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
