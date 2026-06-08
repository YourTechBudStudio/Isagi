import { Effect } from 'effect';
import { Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type { PathSuggestion } from '@isagi/contracts';

import { Chip } from '../../components/Chip.js';
import { Overline } from '../../components/Overline.js';
import { surfaceTransition, uiTransition } from '../../lib/motion.js';
import { buildPaletteContext } from '../../lib/palette/context.js';
import { assembleEntries } from '../../lib/palette/entries.js';
import { GROUP_LABELS } from '../../lib/palette/groups.js';
import {
  computeStepOptions,
  defaultOptionIndex,
  filterEntries,
  firstUnfilledStep,
  labelForValue,
  nextVisibleStep,
  prevVisibleStep,
  recencyView,
} from '../../lib/palette/model.js';
import { GLOBAL_COMMANDS } from '../../lib/palette/registry.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import type {
  ArgPayloads,
  ArgSpec,
  ArgValues,
  Option,
  PaletteCommand,
  PaletteEntry,
  ReviewContent,
  ReviewChoice,
} from '../../lib/palette/types.js';
import { modKey } from '../../lib/platform.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import { formatRuntimeError, suggestProjectPaths } from '../../lib/workspace/runtime-data.js';

export function CommandPalette() {
  const open = usePaletteStore((state) => state.open);
  const autostartCommandId = usePaletteStore((state) => state.autostartCommandId);
  const autostartValues = usePaletteStore((state) => state.autostartValues);
  const recents = usePaletteStore((state) => state.recents);
  const openPalette = usePaletteStore((state) => state.openPalette);
  const closePalette = usePaletteStore((state) => state.closePalette);
  const pushRecent = usePaletteStore((state) => state.pushRecent);

  const { projects, activeWorktreeId } = useWorkspace();
  const ctx = useMemo(
    () => buildPaletteContext(projects, activeWorktreeId),
    [projects, activeWorktreeId],
  );
  const allEntries = useMemo(() => assembleEntries(ctx), [ctx]);

  const [query, setQuery] = useState('');
  const [command, setCommand] = useState<PaletteCommand | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<ArgValues>({});
  const [payloads, setPayloads] = useState<ArgPayloads>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [sel, setSel] = useState<number | null>(0);
  const [stepOptions, setStepOptions] = useState<readonly Option[]>([]);
  const [stepOptionsLoading, setStepOptionsLoading] = useState(false);
  const [stepOptionsError, setStepOptionsError] = useState<string | null>(null);
  const [pathSuggestions, setPathSuggestions] = useState<readonly PathSuggestion[]>([]);
  const [pathError, setPathError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [reviewContent, setReviewContent] = useState<ReviewContent | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards `command.run` to one invocation per wizard run. `command.run` can be
  // a non-idempotent runtime mutation (e.g. open-worktree creates a worktree),
  // and the review auto-finish path fires it from an effect — under StrictMode's
  // double-invoke (or a synchronous review loader) that could run twice. Reset
  // whenever a wizard (re)starts; cleared on failure so the user can retry.
  const finishedRef = useRef(false);
  // The path value the last Enter filled into the buffer. Pressing Enter again
  // with no edits since (buffer still equals it) commits — robust to the async
  // suggestion refresh, which the live highlight is not. Typing clears it.
  const lastFilledPath = useRef<string | null>(null);

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
          closePalette();
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
  }, [open, openPalette, closePalette]);

  // Reset on open; jump straight into a wizard when autostarted.
  useEffect(() => {
    if (!open) {
      return;
    }
    finishedRef.current = false;
    setQuery('');
    setCommandError(null);
    const autostart = autostartCommandId
      ? GLOBAL_COMMANDS.find((entry) => entry.id === autostartCommandId && entry.args?.length)
      : undefined;

    if (!autostart?.args?.length) {
      setValues({});
      setPayloads({});
      setLabels({});
      setStepOptions([]);
      setStepOptionsError(null);
      setStepOptionsLoading(false);
      setReviewContent(null);
      setReviewError(null);
      setReviewLoading(false);
      setStepIndex(0);
      setCommand(null);
      return;
    }

    const initialValues = { ...autostartValues };
    const initialLabels = Object.fromEntries(
      autostart.args
        .filter((arg) => initialValues[arg.key] !== undefined)
        .map((arg) => [
          arg.key,
          labelForValue(arg, initialValues[arg.key] as string, ctx, initialValues),
        ]),
    );

    setValues(initialValues);
    setPayloads({});
    setLabels(initialLabels);
    setStepOptions([]);
    setStepOptionsError(null);
    setStepOptionsLoading(false);
    setReviewContent(null);
    setReviewError(null);
    setReviewLoading(false);
    setStepIndex(firstUnfilledStep(autostart.args, initialValues));
    setCommand(autostart);
  }, [open, autostartCommandId, autostartValues, ctx]);

  const args = command?.args ?? [];
  const spec: ArgSpec | undefined = command ? args[stepIndex] : undefined;

  const view = useMemo(() => {
    if (command && spec) {
      if (spec.kind === 'text') {
        return {
          kind: 'text' as const,
          value: query.trim() || spec.default?.(ctx, values) || '',
          placeholder: spec.placeholder,
        };
      }

      if (spec.kind === 'path') {
        return {
          kind: 'path' as const,
          value: query.trim(),
          suggestions: pathSuggestions,
          error: pathError,
          placeholder: spec.placeholder,
        };
      }

      if (spec.kind === 'review') {
        return {
          kind: 'review' as const,
          content: reviewContent,
          error: reviewError,
          loading: reviewLoading,
        };
      }

      const options = computeStepOptions(spec, stepOptions, query);
      return {
        kind: 'wizard' as const,
        error: stepOptionsError,
        hint: spec.emptyHint,
        loading: stepOptionsLoading,
        options,
      };
    }
    const items = query ? filterEntries(allEntries, query) : recencyView(allEntries, recents);
    return { kind: 'list' as const, items };
  }, [
    command,
    spec,
    ctx,
    values,
    query,
    allEntries,
    recents,
    pathSuggestions,
    pathError,
    stepOptions,
    stepOptionsError,
    stepOptionsLoading,
    reviewContent,
    reviewError,
    reviewLoading,
  ]);

  useEffect(() => {
    if (!open || !command || (spec?.kind !== 'select' && spec?.kind !== 'combo')) {
      setStepOptions([]);
      setStepOptionsError(null);
      setStepOptionsLoading(false);
      return;
    }

    let cancelled = false;
    setStepOptionsError(null);

    try {
      const loaded = spec.options(ctx, values);
      if (loaded instanceof Promise) {
        setStepOptionsLoading(true);
        void loaded
          .then(
            (options) => {
              if (!cancelled) {
                setStepOptions(options);
                setStepOptionsError(null);
              }
            },
            (error: unknown) => {
              if (!cancelled) {
                setStepOptions([]);
                setStepOptionsError(error instanceof Error ? error.message : String(error));
              }
            },
          )
          .finally(() => {
            if (!cancelled) {
              setStepOptionsLoading(false);
            }
          });
      } else {
        setStepOptions(loaded);
        setStepOptionsLoading(false);
      }
    } catch (error) {
      setStepOptions([]);
      setStepOptionsLoading(false);
      setStepOptionsError(error instanceof Error ? error.message : String(error));
    }

    return () => {
      cancelled = true;
    };
  }, [open, command, spec, ctx, values]);

  useEffect(() => {
    if (!open || !command || spec?.kind !== 'review') {
      setReviewContent(null);
      setReviewError(null);
      setReviewLoading(false);
      return;
    }

    let cancelled = false;
    setReviewError(null);

    // A review step whose load resolves to `null` has nothing to ask: finish the
    // wizard and run the command directly (the review is always the terminal step).
    const settle = (content: ReviewContent | null) => {
      if (cancelled) {
        return;
      }
      if (content === null) {
        finishCommandRun(command, values, payloads);
        return;
      }
      setReviewContent(content);
      setReviewError(null);
    };

    try {
      const loaded = spec.load(ctx, values);
      if (loaded instanceof Promise) {
        setReviewLoading(true);
        void loaded
          .then(settle, (error: unknown) => {
            if (!cancelled) {
              setReviewContent(null);
              setReviewError(error instanceof Error ? error.message : String(error));
            }
          })
          .finally(() => {
            if (!cancelled) {
              setReviewLoading(false);
            }
          });
      } else {
        setReviewLoading(false);
        settle(loaded);
      }
    } catch (error) {
      setReviewContent(null);
      setReviewLoading(false);
      setReviewError(error instanceof Error ? error.message : String(error));
    }

    return () => {
      cancelled = true;
    };
    // `finishCommandRun` is intentionally excluded: it is re-created every render,
    // so including it would re-fire `spec.load` (and preflight) on every render.
    // It is stable for a given wizard run and guarded against double-invocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, command, spec, ctx, values, payloads]);

  useEffect(() => {
    if (!open || !command || spec?.kind !== 'path') {
      setPathSuggestions([]);
      setPathError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Effect.runPromise(suggestProjectPaths(query)).then(
        (output) => {
          if (!cancelled) {
            setPathSuggestions(output.suggestions);
            setPathError(null);
          }
        },
        (error: unknown) => {
          if (!cancelled) {
            setPathSuggestions([]);
            setPathError(error instanceof Error ? error.message : String(error));
          }
        },
      );
    }, 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, command, spec?.kind, query]);

  const length =
    view.kind === 'wizard'
      ? view.options.length
      : view.kind === 'list'
        ? view.items.length
        : view.kind === 'path'
          ? view.suggestions.length
          : view.kind === 'review'
            ? (view.content?.choices.length ?? 0)
            : 0;
  const viewKey = command ? `wizard-${stepIndex}` : query ? 'search' : 'recent';
  const defaultIndex = view.kind === 'wizard' && spec ? defaultOptionIndex(spec, view.options) : 0;

  // Snap the selection to the default whenever the view changes shape.
  useEffect(() => {
    setSel(query === '' ? defaultIndex : length > 0 ? 0 : null);
  }, [viewKey, query, defaultIndex, length]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open, viewKey]);

  const enterWizard = (next: PaletteCommand) => {
    finishedRef.current = false;
    setCommand(next);
    setStepIndex(0);
    setValues({});
    setPayloads({});
    setLabels({});
    setStepOptions([]);
    setStepOptionsError(null);
    setStepOptionsLoading(false);
    setReviewContent(null);
    setReviewError(null);
    setReviewLoading(false);
    setQuery('');
  };

  const finish = () => {
    closePalette();
  };

  // Run a command to completion and close the palette, surfacing any failure as
  // the inline command error. Shared by the wizard's accept path and the review
  // step's auto-finish (when a review resolves to `null`, i.e. nothing to ask).
  const finishCommandRun = (cmd: PaletteCommand, runValues: ArgValues, runPayloads: ArgPayloads) => {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    const result = cmd.run(runValues, ctx, runPayloads);
    if (result instanceof Promise) {
      void result.then(
        () => {
          pushRecent(cmd.id);
          finish();
        },
        (error: unknown) => {
          // Let the user retry from the same step.
          finishedRef.current = false;
          setCommandError(formatRuntimeError(error));
        },
      );
    } else {
      pushRecent(cmd.id);
      finish();
    }
  };

  const runEntry = (entry: PaletteEntry) => {
    if (entry.command) {
      enterWizard(entry.command);
    } else {
      entry.run();
      pushRecent(entry.id);
      finish();
    }
  };

  const acceptValue = (value: string, label: string, payload?: unknown) => {
    if (!command || !spec || !value) {
      return;
    }
    const nextValues = { ...values, [spec.key]: value };
    const nextPayloads = { ...payloads, [spec.key]: payload };
    const nextLabels = { ...labels, [spec.key]: label };
    const finishOnAccept =
      (spec.kind === 'select' || spec.kind === 'combo') &&
      (spec.finishOnAccept?.(value, payload, ctx, nextValues) ?? false);
    // Skip any now-irrelevant steps; if none remain, the wizard is done.
    const next = nextVisibleStep(args, stepIndex + 1, ctx, nextValues, nextPayloads);
    if (finishOnAccept || next >= args.length) {
      finishCommandRun(command, nextValues, nextPayloads);
    } else {
      setValues(nextValues);
      setPayloads(nextPayloads);
      setLabels(nextLabels);
      setStepOptions([]);
      setStepOptionsError(null);
      setStepOptionsLoading(false);
      setReviewContent(null);
      setReviewError(null);
      setReviewLoading(false);
      setQuery('');
      setStepIndex(next);
    }
  };

  const acceptOption = (option: Option) => {
    acceptValue(option.value, option.label ?? option.value, option.payload);
  };

  const acceptReviewChoice = (choice: ReviewChoice) => {
    acceptValue(choice.value, choice.label, choice.payload);
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
    if (view.value && view.value === lastFilledPath.current) {
      acceptValue(view.value, view.value);
      return;
    }
    const highlighted = sel === null ? undefined : view.suggestions[sel];
    if (highlighted && highlighted.path !== view.value) {
      lastFilledPath.current = highlighted.path;
      setQuery(highlighted.path);
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
    } else {
      acceptText();
    }
  };

  const back = () => {
    if (!command) {
      closePalette();
      return;
    }
    const previous = prevVisibleStep(args, stepIndex, ctx, values, payloads);
    if (previous !== null) {
      const previousKey = args[previous]?.key;
      if (previousKey) {
        setValues((current) => {
          const next = { ...current };
          delete next[previousKey];
          return next;
        });
        setPayloads((current) => {
          const next = { ...current };
          delete next[previousKey];
          return next;
        });
        setLabels((current) => {
          const next = { ...current };
          delete next[previousKey];
          return next;
        });
      }
      setStepOptions([]);
      setStepOptionsError(null);
      setStepOptionsLoading(false);
      setQuery('');
      setStepIndex(previous);
    } else {
      setCommand(null);
      setStepOptions([]);
      setStepOptionsError(null);
      setStepOptionsLoading(false);
      setQuery('');
    }
  };

  const cycleSel = (delta: number) => {
    setSel((current) => {
      if (length === 0) {
        return null;
      }
      if (current === null) {
        return delta < 0 ? length - 1 : 0;
      }
      return (current + delta + length) % length;
    });
  };

  // Tab fills the buffer with the highlighted directory without submitting, so
  // Enter afterwards commits it. Path-step only.
  const fillPath = () => {
    if (view.kind !== 'path') {
      return;
    }
    const highlighted = sel === null ? undefined : view.suggestions[sel];
    if (highlighted) {
      lastFilledPath.current = highlighted.path;
      setQuery(highlighted.path);
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
        .slice(0, stepIndex)
        .filter((arg) => !(arg.kind === 'select' && (arg.skip?.(ctx, values, payloads) ?? false)))
        .map((arg) => labels[arg.key] ?? '')
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
              closePalette();
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
              ) : (
                <span className="font-mono text-[13px] text-blue">{modKey}K</span>
              )}
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setCommandError(null);
                  lastFilledPath.current = null;
                  setQuery(event.target.value);
                }}
                onKeyDown={onKeyDown}
                placeholder={
                  command
                    ? spec?.kind === 'combo'
                      ? 'choose or type a name…'
                      : spec?.kind === 'text' || spec?.kind === 'path'
                        ? (spec.placeholder ?? 'type a value…')
                        : 'choose…'
                    : 'Type a command…'
                }
                className="min-w-30 flex-1 bg-transparent font-sans text-[15px] text-fg outline-none placeholder:text-fg-subtle"
              />
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

            <Tip mode={command ? (spec?.kind === 'path' ? 'path' : 'wizard') : 'list'} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
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
        No matches. Maybe try a different query?
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
        {value ? 'Press enter to use:' : (placeholder ?? 'Type a value, then press enter.')}
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
          {value ? 'Press enter to add this path:' : 'Type a repository root path.'}
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
    return <p className="px-3 py-4 font-mono text-[12px] text-fg-subtle">Reading setup hooks…</p>;
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
        {content.choices.map((choice, index) => (
          <button
            type="button"
            key={choice.value}
            onClick={() => onPick(index)}
            className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left ${
              index === sel ? 'bg-white/8' : 'hover:bg-white/4'
            }`}
          >
            <span className="w-4 text-center font-mono text-[12px] text-fg-subtle">
              {index === sel ? '●' : '○'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] text-fg">{choice.label}</span>
              {choice.hint && (
                <span className="block truncate font-mono text-[10.5px] text-fg-subtle">
                  {choice.hint}
                </span>
              )}
            </span>
          </button>
        ))}
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
      {loading && <p className="px-3 py-4 font-mono text-[12px] text-fg-subtle">Loading…</p>}
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

function Tip({ mode }: { mode: 'list' | 'wizard' | 'path' }) {
  return (
    <div className="flex items-center gap-3 border-t border-line/14 px-4 py-2.5 font-mono text-[11px] text-fg-subtle">
      {mode === 'path' ? (
        <>
          <TipKey hint="cycle">↑↓</TipKey>
          <TipKey hint="fill">tab</TipKey>
          <TipKey hint="fill/add">↵</TipKey>
          <TipKey hint="back">esc</TipKey>
          <span className="ml-auto opacity-70">/ to go deeper</span>
        </>
      ) : mode === 'wizard' ? (
        <>
          <TipKey hint="cycle">↑↓</TipKey>
          <TipKey hint="select">↵</TipKey>
          <TipKey hint="back">esc</TipKey>
        </>
      ) : (
        <>
          <TipKey hint="move">↑↓</TipKey>
          <TipKey hint="run">↵</TipKey>
          <TipKey hint="close">esc</TipKey>
          <span className="ml-auto opacity-70">tip: {modKey}K from anywhere</span>
        </>
      )}
    </div>
  );
}
