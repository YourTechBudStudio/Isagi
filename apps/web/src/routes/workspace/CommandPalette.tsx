import { Effect } from 'effect';
import { Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useReducer,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type { PathSuggestion } from '@isagi/contracts';

import { Chip } from '../../components/Chip.js';
import { Overline } from '../../components/Overline.js';
import { paletteCopy } from '../../copy/index.js';
import { surfaceTransition, uiTransition } from '../../lib/motion.js';
import { workbenchActionCommands } from '../../lib/palette/commands/workbench-actions.js';
import { buildPaletteContext } from '../../lib/palette/context.js';
import { resolveCommandPreflight } from '../../lib/palette/dispatcher.js';
import { assembleEntries } from '../../lib/palette/entries.js';
import { GROUP_LABELS } from '../../lib/palette/groups.js';
import {
  currentStep,
  initialPaletteState,
  paletteReducer,
  stepDefaultIndex,
  type PaletteEffect,
  type PaletteEvent,
  type PaletteState,
} from '../../lib/palette/machine.js';
import {
  computeStepOptions,
  commandForEntryId,
  filterEntries,
  recencyView,
} from '../../lib/palette/model.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import type {
  CommandErrorContent,
  CommandOutcomeAction,
  CommandOutcomeTone,
  CommandResultContent,
  Option,
  PaletteCommand,
  PaletteContext,
  PaletteEntry,
  ReviewChoice,
  ReviewContent,
} from '../../lib/palette/types.js';
import { modKey } from '../../lib/platform.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import { formatRuntimeError, suggestProjectPaths } from '../../lib/workspace/runtime-data.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';

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
  const ctx = useMemo(
    () =>
      buildPaletteContext(projects, activeWorktreeId, {
        activeSurfaceByWorktreeId,
        activePaneBySurfaceId,
      }),
    [projects, activeWorktreeId, activeSurfaceByWorktreeId, activePaneBySurfaceId],
  );
  const allEntries = useMemo(() => assembleEntries(ctx), [ctx]);

  const [machine, send] = useReducer(paletteReducer, initialPaletteState);
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
  }, [closePalette, machine.kind, open]);

  // Global hotkeys: Mod+K toggles the palette, Mod+N opens Add project.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) {
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
  const acceptsInput = machine.kind === 'search' || machine.kind === 'step';

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

  const view = useMemo(() => {
    if (machine.kind === 'result') {
      return { kind: 'result' as const, content: machine.content };
    }
    if (machine.kind === 'error') {
      return { kind: 'error' as const, content: machine.content };
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
  }, [machine, command, spec, allEntries, recents]);

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

  const length =
    view.kind === 'wizard'
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
  const baseViewKey =
    machine.kind === 'step'
      ? `wizard-${machine.flow.stepIndex}:${query}`
      : machine.kind === 'search'
        ? query
          ? `search:${query}`
          : 'recent'
        : machine.kind === 'result' || machine.kind === 'error'
          ? machine.viewKey
          : 'closed';
  const defaultIndex = view.kind === 'wizard' ? stepDefaultIndex(spec, view.options) : 0;
  const viewKey = `${baseViewKey}:${length}:${defaultIndex ?? 'none'}`;

  // Snap the selection to the default whenever the view changes shape.
  useEffect(() => {
    if (!open) {
      return;
    }
    send({ type: 'view-snap', viewKey, length, defaultIndex });
  }, [open, viewKey, length, defaultIndex]);

  useEffect(() => {
    if (open && (machine.kind === 'search' || machine.kind === 'step')) {
      inputRef.current?.focus();
    }
  }, [open, machine.kind, viewKey]);

  const runEntry = (entry: PaletteEntry) => {
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
    if (highlighted && highlighted.path !== view.value) {
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
        send({ type: 'move-selection', delta: 1, length });
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        send({ type: 'move-selection', delta: -1, length });
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
  }, [ctx, length, open, sel, view]);

  const back = () => {
    send({ type: 'back', command: command ?? undefined, ctx });
  };

  const cycleSel = (delta: number) => {
    send({ type: 'move-selection', delta, length });
  };

  // Tab fills the buffer with the highlighted directory without submitting, so
  // Enter afterwards commits it. Path-step only.
  const fillPath = () => {
    if (view.kind !== 'path') {
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

  const crumbLabels = command
    ? args
        .slice(0, machine.kind === 'step' ? machine.flow.stepIndex : 0)
        .filter(
          (arg) =>
            machine.kind !== 'step' ||
            !(
              arg.kind === 'select' &&
              (arg.skip?.(ctx, machine.flow.values, machine.flow.payloads) ?? false)
            ),
        )
        .map((arg) => (machine.kind === 'step' ? (machine.flow.labels[arg.key] ?? '') : ''))
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
              {command ? (
                <>
                  <Chip tone="command">{command.label}</Chip>
                  {crumbLabels.map((label, index) => (
                    <span key={args[index]?.key} className="flex items-center gap-1.5">
                      <span className="text-[11px] text-fg-subtle">›</span>
                      <Chip tone="crumb">{label}</Chip>
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
                  {paletteCopy.outcome.localFeedback}
                </span>
              )}
            </div>

            {commandError && (
              <p className="border-b border-error/18 bg-error/8 px-4 py-2.5 font-mono text-[11.5px] text-error">
                {commandError}
              </p>
            )}

            <motion.div
              key={viewKey}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={uiTransition}
              className="max-h-[46vh] overflow-y-auto p-1.5"
            >
              {view.kind === 'wizard' ? (
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
                  error={view.error}
                  sel={sel}
                  onPick={(index) => {
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
                view.kind === 'result' || view.kind === 'error'
                  ? 'outcome'
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

function runPaletteEffects(
  effects: readonly PaletteEffect[],
  options: {
    readonly allEntries: readonly PaletteEntry[];
    readonly ctx: PaletteContext;
    readonly send: Dispatch<PaletteEvent>;
    readonly pushRecent: (entryId: string) => void;
    readonly pathSuggestTimer: { current: number | null };
    readonly seenEffectIds: { current: Set<number> };
  },
) {
  const pending = effects.filter((effect) => !options.seenEffectIds.current.has(effect.id));
  if (pending.length === 0) {
    return;
  }

  for (const effect of pending) {
    options.seenEffectIds.current.add(effect.id);
  }
  options.send({ type: 'effects-consumed', ids: pending.map((effect) => effect.id) });

  for (const effect of pending) {
    runPaletteEffect(effect, options);
  }
}

function runPaletteEffect(
  effect: PaletteEffect,
  options: {
    readonly allEntries: readonly PaletteEntry[];
    readonly ctx: PaletteContext;
    readonly send: Dispatch<PaletteEvent>;
    readonly pushRecent: (entryId: string) => void;
    readonly pathSuggestTimer: { current: number | null };
  },
) {
  if (effect.kind === 'preflight') {
    const command = resolveCommandByIds(options.allEntries, effect.entryId, effect.commandId);
    if (!command) {
      options.send({
        type: 'preflight-failed',
        attemptId: effect.attemptId,
        error: paletteCopy.outcome.commandUnavailableTitle,
      });
      return;
    }
    void resolveMaybe(() => resolveCommandPreflight(command, options.ctx, effect.values)).then(
      (result) =>
        options.send({
          type: 'preflight-succeeded',
          attemptId: effect.attemptId,
          entryId: effect.entryId,
          command,
          ctx: options.ctx,
          result,
        }),
      (error: unknown) =>
        options.send({
          type: 'preflight-failed',
          attemptId: effect.attemptId,
          error: formatRuntimeError(error),
        }),
    );
    return;
  }

  if (effect.kind === 'loadOptions') {
    const command = resolveCommandByIds(options.allEntries, effect.entryId, effect.commandId);
    const spec = command?.args?.[effect.stepIndex];
    if (!spec || (spec.kind !== 'select' && spec.kind !== 'combo')) {
      options.send({
        type: 'options-failed',
        attemptId: effect.attemptId,
        error: paletteCopy.outcome.commandUnavailableTitle,
      });
      return;
    }
    void resolveMaybe(() => spec.options(options.ctx, effect.values)).then(
      (loaded) =>
        options.send({ type: 'options-loaded', attemptId: effect.attemptId, options: loaded }),
      (error: unknown) =>
        options.send({
          type: 'options-failed',
          attemptId: effect.attemptId,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return;
  }

  if (effect.kind === 'loadReview') {
    const command = resolveCommandByIds(options.allEntries, effect.entryId, effect.commandId);
    const spec = command?.args?.[effect.stepIndex];
    if (!spec || spec.kind !== 'review') {
      options.send({
        type: 'review-failed',
        attemptId: effect.attemptId,
        error: paletteCopy.outcome.commandUnavailableTitle,
      });
      return;
    }
    void resolveMaybe(() => spec.load(options.ctx, effect.values)).then(
      (content) =>
        options.send({
          type: 'review-loaded',
          attemptId: effect.attemptId,
          command,
          ctx: options.ctx,
          content,
        }),
      (error: unknown) =>
        options.send({
          type: 'review-failed',
          attemptId: effect.attemptId,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return;
  }

  if (effect.kind === 'suggestPaths') {
    if (options.pathSuggestTimer.current !== null) {
      window.clearTimeout(options.pathSuggestTimer.current);
    }
    options.pathSuggestTimer.current = window.setTimeout(() => {
      options.pathSuggestTimer.current = null;
      void Effect.runPromise(suggestProjectPaths(effect.query)).then(
        (output) =>
          options.send({
            type: 'paths-loaded',
            attemptId: effect.attemptId,
            suggestions: output.suggestions,
          }),
        (error: unknown) =>
          options.send({
            type: 'paths-failed',
            attemptId: effect.attemptId,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    }, 80);
    return;
  }

  const entry = options.allEntries.find((candidate) => candidate.id === effect.entryId);
  const command = effect.commandId
    ? resolveCommandByIds(options.allEntries, effect.entryId, effect.commandId)
    : null;
  const run = command
    ? () => command.run(effect.values, options.ctx, effect.payloads)
    : entry
      ? () => entry.run()
      : null;

  if (!run) {
    options.send({
      type: 'run-failed',
      attemptId: effect.attemptId,
      error: paletteCopy.outcome.commandUnavailableTitle,
    });
    return;
  }

  void resolveMaybe(run).then(
    (outcome) => {
      options.pushRecent(effect.entryId);
      options.send({ type: 'run-succeeded', attemptId: effect.attemptId, outcome });
    },
    (error: unknown) =>
      options.send({
        type: 'run-failed',
        attemptId: effect.attemptId,
        error: formatRuntimeError(error),
      }),
  );
}

function resolveMaybe<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error);
  }
}

function resolveStateCommand(
  state: PaletteState,
  entries: readonly PaletteEntry[],
): PaletteCommand | null {
  if (state.kind !== 'step') {
    return null;
  }
  return resolveCommandByIds(entries, state.flow.entryId, state.flow.commandId);
}

function resolveCommandByIds(
  entries: readonly PaletteEntry[],
  entryId: string,
  commandId: string,
): PaletteCommand | null {
  return (
    entries.find((entry) => entry.id === entryId && entry.command?.id === commandId)?.command ??
    workbenchActionCommands.find((command) => command.id === entryId && command.id === commandId) ??
    null
  );
}

function commandForWorkbenchActionId(entryId: string | null): {
  readonly entryId: string;
  readonly command: PaletteCommand;
  readonly values?: PaletteEntry['values'];
} | null {
  if (!entryId) {
    return null;
  }
  const command = workbenchActionCommands.find((candidate) => candidate.id === entryId);
  return command ? { entryId, command } : null;
}

function outcomeActions(content: CommandResultContent | CommandErrorContent) {
  return content.actions?.length
    ? content.actions
    : [{ value: 'close', label: paletteCopy.outcome.close } satisfies CommandOutcomeAction];
}

function OutcomePanel({
  content,
  kind,
  onAction,
}: {
  content: CommandResultContent | CommandErrorContent;
  kind: 'result' | 'error';
  onAction: (value: string) => void;
}) {
  const tone = kind === 'error' ? (content.tone ?? 'danger') : (content.tone ?? 'info');
  const toneClass = outcomeToneClass(tone);
  return (
    <div className="px-3 py-3">
      <div className={`rounded-md border p-3 ${toneClass.frame}`}>
        <p className={`text-[13.5px] font-medium ${toneClass.title}`}>{content.title}</p>
        {content.body && (
          <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">{content.body}</p>
        )}
        {content.diagnostic && (
          <div className="mt-3 rounded-sm border border-line/18 bg-scrim/28 p-2">
            <p className="font-mono text-[10.5px] text-fg-subtle">
              {content.diagnostic.label || paletteCopy.outcome.diagnostic}
            </p>
            <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-fg-muted">
              {content.diagnostic.detail}
            </pre>
          </div>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {outcomeActions(content).map((action) => (
          <button
            key={action.value}
            type="button"
            onClick={() => onAction(action.value)}
            className={`rounded-sm px-3 py-1.5 text-[12.5px] transition duration-micro ease-expo ${outcomeActionClass(action)}`}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function outcomeToneClass(tone: CommandOutcomeTone) {
  if (tone === 'success') {
    return { frame: 'border-green/22 bg-green/8', title: 'text-green' };
  }
  if (tone === 'warning') {
    return { frame: 'border-amber/24 bg-amber/8', title: 'text-amber' };
  }
  if (tone === 'danger') {
    return { frame: 'border-error/24 bg-error/8', title: 'text-error' };
  }
  return { frame: 'border-blue/20 bg-blue/8', title: 'text-fg' };
}

function outcomeActionClass(action: CommandOutcomeAction) {
  if (action.intent === 'danger') {
    return 'bg-error/14 text-error hover:bg-error/20';
  }
  if (action.intent === 'primary') {
    return 'bg-blue/16 text-blue hover:bg-blue/22';
  }
  if (action.intent === 'cancel') {
    return 'bg-white/5 text-fg-muted hover:bg-white/8';
  }
  return 'bg-white/8 text-fg hover:bg-white/12';
}

function EntryList({
  items,
  sel,
  onPick,
}: {
  items: readonly PaletteEntry[];
  sel: number | null;
  onPick: (index: number) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="px-3 py-6 text-center font-mono text-[12px] text-fg-subtle">
        {paletteCopy.emptySearch}
      </p>
    );
  }

  let lastGroup: string | null = null;
  return (
    <>
      {items.map((entry, index) => {
        const Icon = entry.icon;
        const header = entry.group !== lastGroup ? GROUP_LABELS[entry.group] : null;
        lastGroup = entry.group;
        return (
          <div key={entry.id}>
            {header && <GroupHeader label={header} />}
            <button
              type="button"
              onClick={() => onPick(index)}
              className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left ${
                index === sel ? 'bg-white/8' : 'hover:bg-white/4'
              }`}
            >
              <Icon
                size={16}
                className={
                  entry.accent ? 'text-violet' : index === sel ? 'text-fg' : 'text-fg-subtle'
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-fg">{entry.label}</span>
                {entry.sub && (
                  <span className="block truncate font-mono text-[10.5px] text-fg-subtle">
                    {entry.sub}
                  </span>
                )}
              </span>
              {entry.command && <span className="font-mono text-[10.5px] text-fg-subtle">›</span>}
            </button>
          </div>
        );
      })}
    </>
  );
}

function TextStep({ value, placeholder }: { value: string; placeholder: string | undefined }) {
  return (
    <div className="px-3 py-4">
      <p className="font-mono text-[11px] text-fg-subtle">
        {value ? paletteCopy.textStep.useValue : (placeholder ?? paletteCopy.textStep.typeThenUse)}
      </p>
      {value && (
        <p className="mt-2 rounded-sm border border-line/22 bg-white/6 px-3 py-2 font-mono text-[13px] text-fg">
          {value}
        </p>
      )}
    </div>
  );
}

function PathOptions({
  suggestions,
  value,
  error,
  sel,
  onPick,
}: {
  suggestions: readonly PathSuggestion[];
  value: string;
  error: string | null;
  sel: number | null;
  onPick: (index: number) => void;
}) {
  if (error) {
    return <p className="px-3 py-4 font-mono text-[12px] text-error">{error}</p>;
  }

  if (suggestions.length === 0) {
    return (
      <div className="px-3 py-4">
        <p className="font-mono text-[11px] text-fg-subtle">
          {value ? paletteCopy.pathStep.addPath : paletteCopy.pathStep.typeRepositoryRoot}
        </p>
        {value && (
          <p className="mt-2 rounded-sm border border-line/22 bg-white/6 px-3 py-2 font-mono text-[13px] text-fg">
            {value}
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      {suggestions.map((suggestion, index) => (
        <button
          type="button"
          key={suggestion.path}
          onClick={() => onPick(index)}
          className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left ${
            index === sel ? 'bg-white/8' : 'hover:bg-white/4'
          }`}
        >
          <span className="w-4 text-center font-mono text-[12px] text-fg-subtle">
            {index === sel ? '●' : '○'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] text-fg">{suggestion.label}</span>
            <span className="block truncate font-mono text-[10.5px] text-fg-subtle">
              {suggestion.path}
            </span>
          </span>
          {suggestion.hidden && (
            <span className="font-mono text-[10.5px] text-fg-subtle">hidden</span>
          )}
        </button>
      ))}
    </>
  );
}

/**
 * Per-choice colour for a review step. `danger` is the only place red appears in
 * the wizard (reserved for the destructive accept); `cancel` reads as a quiet
 * back-out; everything else is the neutral choice tone.
 */
function reviewChoiceTone(intent: ReviewChoice['intent'], selected: boolean) {
  if (intent === 'danger') {
    return {
      row: selected ? 'bg-error/14' : 'hover:bg-error/8',
      glyph: 'text-error',
      label: 'text-error',
    };
  }
  if (intent === 'cancel') {
    return {
      row: selected ? 'bg-white/8' : 'hover:bg-white/4',
      glyph: 'text-fg-subtle',
      label: 'text-fg-muted',
    };
  }
  return {
    row: selected ? 'bg-white/8' : 'hover:bg-white/4',
    glyph: 'text-fg-subtle',
    label: 'text-fg',
  };
}

function ReviewStep({
  content,
  error,
  loading,
  sel,
  onPick,
}: {
  content: ReviewContent | null;
  error: string | null;
  loading: boolean;
  sel: number | null;
  onPick: (index: number) => void;
}) {
  if (error) {
    return <p className="px-3 py-4 font-mono text-[12px] text-error">{error}</p>;
  }
  if (loading || !content) {
    return (
      <p className="px-3 py-4 font-mono text-[12px] text-fg-subtle">
        {paletteCopy.reviewStep.loading}
      </p>
    );
  }

  return (
    <div className="px-3 py-3">
      <p className="text-[13.5px] font-medium text-fg">{content.title}</p>
      <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">{content.body}</p>
      {content.items.length > 0 && (
        <div className="mt-3 space-y-1.5 rounded-md border border-line/20 bg-white/5 p-2">
          {content.items.map((item, index) => (
            <div key={`${item.label}-${index}`} className="rounded-sm px-2 py-1.5">
              <p className="font-mono text-[11.5px] text-fg">
                {index + 1}. {item.label}
              </p>
              {item.detail && (
                <p className="mt-0.5 font-mono text-[10.5px] text-fg-subtle">{item.detail}</p>
              )}
              {item.envKeys && item.envKeys.length > 0 && (
                <p className="mt-0.5 font-mono text-[10.5px] text-fg-subtle">
                  env: {item.envKeys.join(', ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 space-y-1">
        {content.choices.map((choice, index) => {
          const tone = reviewChoiceTone(choice.intent, index === sel);
          return (
            <button
              type="button"
              key={choice.value}
              onClick={() => onPick(index)}
              className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left ${tone.row}`}
            >
              <span className={`w-4 text-center font-mono text-[12px] ${tone.glyph}`}>
                {index === sel ? '●' : '○'}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[13.5px] ${tone.label}`}>{choice.label}</span>
                {choice.hint && (
                  <span className="block truncate font-mono text-[10.5px] text-fg-subtle">
                    {choice.hint}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WizardOptions({
  options,
  sel,
  error,
  hint,
  loading,
  onPick,
}: {
  options: readonly Option[];
  sel: number | null;
  error?: string | null | undefined;
  hint?: string | undefined;
  loading?: boolean | undefined;
  onPick: (index: number) => void;
}) {
  if (error) {
    return <p className="px-3 py-4 font-mono text-[12px] text-error">{error}</p>;
  }

  return (
    <>
      {hint && <p className="px-3 py-2 font-mono text-[11px] text-fg-subtle">{hint}</p>}
      {loading && (
        <p className="px-3 py-4 font-mono text-[12px] text-fg-subtle">
          {paletteCopy.wizardStep.loading}
        </p>
      )}
      {options.map((option, index) =>
        option.create ? (
          <button
            type="button"
            key={option.value}
            onClick={() => onPick(index)}
            className={`mx-1 my-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-md border px-3 py-2.25 text-left transition duration-micro ease-expo ${
              index === sel
                ? 'border-green/45 bg-green/16'
                : 'border-green/30 bg-green/10 hover:bg-green/16'
            }`}
          >
            <Plus size={14} className="shrink-0 text-green" />
            <span className="flex-1 truncate text-[13.5px] font-medium text-green">
              {option.label ?? option.value}
            </span>
            {option.hint && (
              <span className="font-mono text-[10.5px] text-green/70">{option.hint}</span>
            )}
          </button>
        ) : (
          <button
            type="button"
            key={option.value}
            onClick={() => onPick(index)}
            className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left ${
              index === sel ? 'bg-white/8' : 'hover:bg-white/4'
            }`}
          >
            <span className="w-4 text-center font-mono text-[12px] text-fg-subtle">
              {index === sel ? '●' : '○'}
            </span>
            <span className="flex-1 truncate text-[13.5px] text-fg">
              {option.label ?? option.value}
            </span>
            {option.isDefault && <span className="font-mono text-[10.5px] text-cyan">default</span>}
            {option.hint && (
              <span className="font-mono text-[10.5px] text-fg-subtle">{option.hint}</span>
            )}
          </button>
        ),
      )}
    </>
  );
}

function GroupHeader({ label }: { label: string }) {
  return <Overline className="px-2.5 pt-2 pb-1 text-[9.5px]">{label}</Overline>;
}

function TipKey({ children, hint }: { children: string; hint: string }) {
  return (
    <span>
      <span className="text-fg-muted">{children}</span> {hint}
    </span>
  );
}

function Tip({ mode }: { mode: 'list' | 'wizard' | 'path' | 'outcome' }) {
  return (
    <div className="flex items-center gap-3 border-t border-line/14 px-4 py-2.5 font-mono text-[11px] text-fg-subtle">
      {mode === 'outcome' ? (
        <>
          <TipKey hint={paletteCopy.tips.close}>esc</TipKey>
        </>
      ) : mode === 'path' ? (
        <>
          <TipKey hint={paletteCopy.tips.cycle}>↑↓</TipKey>
          <TipKey hint={paletteCopy.tips.fill}>tab</TipKey>
          <TipKey hint={paletteCopy.tips.fillOrAdd}>↵</TipKey>
          <TipKey hint={paletteCopy.tips.back}>esc</TipKey>
          <span className="ml-auto opacity-70">{paletteCopy.pathStep.goDeeper}</span>
        </>
      ) : mode === 'wizard' ? (
        <>
          <TipKey hint={paletteCopy.tips.cycle}>↑↓</TipKey>
          <TipKey hint={paletteCopy.tips.select}>↵</TipKey>
          <TipKey hint={paletteCopy.tips.back}>esc</TipKey>
        </>
      ) : (
        <>
          <TipKey hint={paletteCopy.tips.move}>↑↓</TipKey>
          <TipKey hint={paletteCopy.tips.run}>↵</TipKey>
          <TipKey hint={paletteCopy.tips.close}>esc</TipKey>
          <span className="ml-auto opacity-70">{paletteCopy.tips.anywhere(modKey)}</span>
        </>
      )}
    </div>
  );
}
