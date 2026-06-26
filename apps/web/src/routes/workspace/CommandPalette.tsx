import { AnimatePresence, motion } from 'motion/react';
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useReducer,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type { PathSuggestion, WorkflowStartContext } from '@isagi/contracts';

import { Chip } from '../../components/Chip.js';
import { paletteCopy } from '../../copy/index.js';
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
import {
  currentStep,
  initialPaletteState,
  isBusy,
  paletteReducer,
  stepDefaultIndex,
} from '../../lib/palette/machine.js';
import {
  computeStepOptions,
  commandForEntryId,
  filterEntries,
  recencyView,
} from '../../lib/palette/model.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import type { Option, PaletteEntry, ReviewChoice } from '../../lib/palette/types.js';
import { isPlatformModifierShortcut, modKey } from '../../lib/platform.js';
import { restoreActivePaneFocus } from '../../lib/workspace/activation.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import {
  useStartWorkflowMutation,
  useSurfaceDetailQuery,
  useWorkflowDescriptorsQuery,
} from '../../lib/workspace/queries.js';
import { formatRuntimeError, formatRuntimeErrorSummary } from '../../lib/workspace/runtime-data.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import { useWorkflowSurfaceStore } from '../../lib/workspace/workflow-surface.js';
import {
  EntryList,
  OutcomePanel,
  PathOptions,
  ReviewStep,
  RunningPanel,
  TextStep,
  Tip,
  WizardOptions,
  outcomeActions,
} from './CommandPaletteViews.js';
import { type WorkflowQuestionAnswers, WorkflowQuestionForm } from './WorkflowQuestionForm.js';

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
  const baseCtx = useMemo(
    () =>
      buildPaletteContext(projects, activeWorktreeId, {
        activeSurfaceByWorktreeId,
        activePaneBySurfaceId,
      }),
    [projects, activeWorktreeId, activeSurfaceByWorktreeId, activePaneBySurfaceId],
  );
  const activeSurfaceWorkflowSummary = useWorkflowSurfaceStore((state) =>
    baseCtx.activeSurface ? state.summariesBySurfaceId[baseCtx.activeSurface.id] : undefined,
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
  const ctx = useMemo(
    () =>
      buildPaletteContext(projects, activeWorktreeId, {
        activeSurfaceByWorktreeId,
        activePaneBySurfaceId,
        workflowDescriptors: workflowDescriptors.data?.workflows,
        activeSurfaceWorkflowSummary,
      }),
    [
      projects,
      activeWorktreeId,
      activeSurfaceByWorktreeId,
      activePaneBySurfaceId,
      workflowDescriptors.data?.workflows,
      activeSurfaceWorkflowSummary,
    ],
  );
  const allEntries = useMemo(() => assembleEntries(ctx), [ctx]);

  const [machine, send] = useReducer(paletteReducer, initialPaletteState);
  const [workflowFormEntryId, setWorkflowFormEntryId] = useState<string | null>(null);
  const startWorkflowMutation = useStartWorkflowMutation();
  const inputRef = useRef<HTMLInputElement>(null);
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
  const sel = machine.kind === 'search' || machine.kind === 'step' ? machine.selectedIndex : null;
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
  const running =
    isBusy(machine) || (startWorkflowMutation.isPending && workflowFormEntryId === null);

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
      if (spec.kind === 'text') {
        return {
          kind: 'text' as const,
          value: machine.query.trim(),
          placeholder: spec.placeholder,
        };
      }

      if (spec.kind === 'path' && machine.stepData.kind === 'path') {
        return {
          kind: 'path' as const,
          value: machine.query.trim(),
          suggestions: machine.stepData.suggestions as readonly PathSuggestion[],
          loading: machine.stepData.loading,
          stale: machine.stepData.suggestionsQuery !== machine.query,
          error: machine.stepData.error,
          placeholder: spec.placeholder,
        };
      }

      if (spec.kind === 'review' && machine.stepData.kind === 'review') {
        return {
          kind: 'review' as const,
          content: machine.stepData.content,
          error: machine.stepData.error,
          loading: machine.stepData.loading,
        };
      }

      const loadedOptions =
        machine.stepData.kind === 'select' || machine.stepData.kind === 'combo'
          ? machine.stepData.options
          : [];
      const options = computeStepOptions(spec, loadedOptions, machine.query);
      return {
        kind: 'wizard' as const,
        error:
          machine.stepData.kind === 'select' || machine.stepData.kind === 'combo'
            ? machine.stepData.error
            : null,
        hint: spec.kind === 'select' || spec.kind === 'combo' ? spec.emptyHint : undefined,
        loading:
          machine.stepData.kind === 'select' || machine.stepData.kind === 'combo'
            ? machine.stepData.loading
            : false,
        options,
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
      : view.kind === 'wizard'
        ? view.options.length
        : view.kind === 'list'
          ? view.items.length
          : view.kind === 'path'
            ? view.suggestions.length
            : view.kind === 'review'
              ? (view.content?.choices.length ?? 0)
              : view.kind === 'result' || view.kind === 'error'
                ? outcomeActions(view.content).length
                : 0;
  const selectableLength = view.kind === 'path' && view.stale ? 0 : renderedLength;
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
      : view.kind === 'wizard'
        ? stepDefaultIndex(spec, view.options)
        : view.kind === 'workflow-form'
          ? null
          : view.kind === 'path' && view.stale
            ? null
            : 0;
  const viewKey = `${baseViewKey}:${selectableLength}:${defaultIndex ?? 'none'}`;
  const panelKey = running
    ? 'running'
    : view.kind === 'workflow-form'
      ? `workflow-form:${view.entry.id}`
      : machine.kind === 'step' && view.kind === 'path'
        ? `path-${machine.flow.stepIndex}`
        : viewKey;

  // Snap the selection to the default whenever the view changes shape.
  useEffect(() => {
    if (!open) {
      return;
    }
    send({ type: 'view-snap', viewKey, length: selectableLength, defaultIndex });
  }, [open, viewKey, selectableLength, defaultIndex]);

  useEffect(() => {
    if (
      open &&
      view.kind !== 'workflow-form' &&
      (machine.kind === 'search' || machine.kind === 'step')
    ) {
      inputRef.current?.focus();
    }
  }, [open, machine.kind, view.kind, viewKey]);

  const workflowStartErrorContent = (error: unknown) => ({
    title: paletteCopy.workflows.startFailed.title,
    body: formatRuntimeErrorSummary(error),
    diagnostic: {
      label: paletteCopy.workflows.startFailed.diagnosticLabel,
      detail: formatRuntimeError(error),
    },
  });

  const startWorkflowEntry = (entry: PaletteEntry, answers: WorkflowQuestionAnswers) => {
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
            content: workflowStartErrorContent(error),
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

  const acceptOption = (option: Option) => {
    acceptValue(option.value, option.label ?? option.value, option.payload);
  };

  const acceptReviewChoice = (choice: ReviewChoice) => {
    if (!command) {
      return;
    }
    send({ type: 'accept-review-choice', command, ctx, choice });
  };

  const acceptText = () => {
    if (view.kind === 'text') {
      acceptValue(view.value, view.value);
    }
  };

  const acceptPath = () => {
    if (view.kind !== 'path') {
      return;
    }
    // Shell-style: Enter fills the input with the highlighted directory rather
    // than submitting. Press it again (buffer unchanged since the fill) to
    // commit, or type "/" to drill into the filled path and keep navigating.
    if (machine.kind === 'step' && view.value && view.value === machine.lastFilledPath) {
      acceptValue(view.value, view.value);
      return;
    }
    const highlighted = sel === null ? undefined : view.suggestions[sel];
    if (!view.stale && highlighted && highlighted.path !== view.value) {
      send({ type: 'fill-path', path: highlighted.path });
      return;
    }
    if (view.value) {
      acceptValue(view.value, view.value);
    }
  };

  const activate = () => {
    if (view.kind === 'list') {
      const entry = sel === null ? undefined : view.items[sel];
      if (entry) {
        runEntry(entry);
      }
    } else if (view.kind === 'wizard') {
      const option = sel === null ? undefined : view.options[sel];
      if (option) {
        acceptOption(option);
      }
    } else if (view.kind === 'path') {
      acceptPath();
    } else if (view.kind === 'review') {
      const choice = sel === null ? undefined : view.content?.choices[sel];
      if (choice) {
        acceptReviewChoice(choice);
      }
    } else if (view.kind === 'result' || view.kind === 'error') {
      const action = outcomeActions(view.content)[sel ?? 0];
      if (action) {
        send({ type: 'outcome-action', value: action.value });
      }
    } else {
      acceptText();
    }
  };

  useEffect(() => {
    if (!open || (view.kind !== 'result' && view.kind !== 'error')) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        send({ type: 'move-selection', delta: 1, length: selectableLength });
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        send({ type: 'move-selection', delta: -1, length: selectableLength });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const action = outcomeActions(view.content)[sel ?? 0];
        if (action) {
          send({ type: 'outcome-action', value: action.value });
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        send({ type: 'back', ctx });
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctx, open, selectableLength, sel, view]);

  const back = () => {
    if (view.kind === 'workflow-form') {
      setWorkflowFormEntryId(null);
      return;
    }
    send({ type: 'back', command: command ?? undefined, ctx });
  };

  const cycleSel = (delta: number) => {
    send({ type: 'move-selection', delta, length: selectableLength });
  };

  // Tab fills the buffer with the highlighted directory without submitting, so
  // Enter afterwards commits it. Path-step only.
  const fillPath = () => {
    if (view.kind !== 'path') {
      return;
    }
    if (view.stale) {
      return;
    }
    const highlighted = sel === null ? undefined : view.suggestions[sel];
    if (highlighted) {
      send({ type: 'fill-path', path: highlighted.path });
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cycleSel(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cycleSel(-1);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      fillPath();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      back();
    } else if (event.key === 'Backspace' && query === '' && command) {
      event.preventDefault();
      back();
    }
  };

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
            initial={{ opacity: 0, y: 6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.985 }}
            transition={surfaceTransition}
            className="h-fit w-145 max-w-full overflow-hidden rounded-lg border border-line/30 bg-elevated/85 shadow-lift backdrop-blur-2xl"
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
                  onKeyDown={onKeyDown}
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
                <div className="px-3 py-3">
                  <WorkflowQuestionForm
                    questions={view.workflow.manifest.inputs ?? []}
                    submitLabel={paletteCopy.workflows.start}
                    disabled={startWorkflowMutation.isPending}
                    onSubmit={(answers) => startWorkflowEntry(view.entry, answers)}
                  />
                </div>
              ) : view.kind === 'wizard' ? (
                <WizardOptions
                  options={view.options}
                  sel={sel}
                  error={view.error}
                  hint={view.hint}
                  loading={view.loading}
                  onPick={(index) => {
                    const option = view.options[index];
                    if (option) {
                      acceptOption(option);
                    }
                  }}
                />
              ) : view.kind === 'path' ? (
                <PathOptions
                  suggestions={view.suggestions}
                  value={view.value}
                  loading={view.loading}
                  stale={view.stale}
                  error={view.error}
                  sel={sel}
                  onPick={(index) => {
                    if (view.stale) {
                      return;
                    }
                    const suggestion = view.suggestions[index];
                    if (suggestion) {
                      acceptValue(suggestion.path, suggestion.path);
                    }
                  }}
                />
              ) : view.kind === 'review' ? (
                <ReviewStep
                  content={view.content}
                  error={view.error}
                  loading={view.loading}
                  sel={sel}
                  onPick={(index) => {
                    const choice = view.content?.choices[index];
                    if (choice) {
                      acceptReviewChoice(choice);
                    }
                  }}
                />
              ) : view.kind === 'text' ? (
                <TextStep value={view.value} placeholder={view.placeholder} />
              ) : view.kind === 'result' ? (
                <OutcomePanel
                  content={view.content}
                  kind="result"
                  onAction={(value) => send({ type: 'outcome-action', value })}
                />
              ) : view.kind === 'error' ? (
                <OutcomePanel
                  content={view.content}
                  kind="error"
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
                        ? spec?.kind === 'path'
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
