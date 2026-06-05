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
  recencyView,
} from '../../lib/palette/model.js';
import { GLOBAL_COMMANDS } from '../../lib/palette/registry.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import type {
  ArgSpec,
  ArgValues,
  Option,
  PaletteCommand,
  PaletteEntry,
} from '../../lib/palette/types.js';
import { modKey } from '../../lib/platform.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';

export function CommandPalette() {
  const open = usePaletteStore((state) => state.open);
  const autostartCommandId = usePaletteStore((state) => state.autostartCommandId);
  const autostartValues = usePaletteStore((state) => state.autostartValues);
  const recents = usePaletteStore((state) => state.recents);
  const openPalette = usePaletteStore((state) => state.openPalette);
  const closePalette = usePaletteStore((state) => state.closePalette);
  const pushRecent = usePaletteStore((state) => state.pushRecent);

  const projects = useWorkspaceStore((state) => state.projects);
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId);
  const suggestPaths = useWorkspaceStore((state) => state.suggestPaths);
  const ctx = useMemo(
    () => buildPaletteContext(projects, activeWorktreeId),
    [projects, activeWorktreeId],
  );
  const allEntries = useMemo(() => assembleEntries(ctx), [ctx]);

  const [query, setQuery] = useState('');
  const [command, setCommand] = useState<PaletteCommand | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<ArgValues>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [sel, setSel] = useState(0);
  const [pathSuggestions, setPathSuggestions] = useState<readonly PathSuggestion[]>([]);
  const [pathError, setPathError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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
    setQuery('');
    setCommandError(null);
    const autostart = autostartCommandId
      ? GLOBAL_COMMANDS.find((entry) => entry.id === autostartCommandId && entry.args?.length)
      : undefined;

    if (!autostart?.args?.length) {
      setValues({});
      setLabels({});
      setStepIndex(0);
      setCommand(null);
      return;
    }

    const initialValues = Object.fromEntries(
      autostart.args
        .filter((arg) => autostartValues[arg.key] !== undefined)
        .map((arg) => [arg.key, autostartValues[arg.key] as string]),
    );
    const initialLabels = Object.fromEntries(
      autostart.args
        .filter((arg) => initialValues[arg.key] !== undefined)
        .map((arg) => [
          arg.key,
          labelForValue(arg, initialValues[arg.key] as string, ctx, initialValues),
        ]),
    );

    setValues(initialValues);
    setLabels(initialLabels);
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

      const options = computeStepOptions(spec, spec.options(ctx, values), query);
      return { kind: 'wizard' as const, options };
    }
    const items = query ? filterEntries(allEntries, query) : recencyView(allEntries, recents);
    return { kind: 'list' as const, items };
  }, [command, spec, ctx, values, query, allEntries, recents, pathSuggestions, pathError]);

  useEffect(() => {
    if (!open || !command || spec?.kind !== 'path') {
      setPathSuggestions([]);
      setPathError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void suggestPaths(query).then(
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
  }, [open, command, spec?.kind, query, suggestPaths]);

  const length =
    view.kind === 'wizard'
      ? view.options.length
      : view.kind === 'list'
        ? view.items.length
        : view.kind === 'path'
          ? view.suggestions.length
          : 0;
  const viewKey = command ? `wizard-${stepIndex}` : query ? 'search' : 'recent';
  const defaultIndex = view.kind === 'wizard' ? defaultOptionIndex(view.options) : 0;

  // Snap the selection to the default whenever the view changes shape.
  useEffect(() => {
    setSel(query === '' ? defaultIndex : 0);
  }, [viewKey, query, defaultIndex]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open, viewKey]);

  const enterWizard = (next: PaletteCommand) => {
    setCommand(next);
    setStepIndex(0);
    setValues({});
    setLabels({});
    setQuery('');
  };

  const finish = () => {
    closePalette();
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

  const acceptValue = (value: string, label: string) => {
    if (!command || !spec || !value) {
      return;
    }
    const nextValues = { ...values, [spec.key]: value };
    const nextLabels = { ...labels, [spec.key]: label };
    if (stepIndex === args.length - 1) {
      const result = command.run(nextValues, ctx);
      if (result instanceof Promise) {
        void result.then(
          () => {
            pushRecent(command.id);
            finish();
          },
          (error: unknown) => {
            setCommandError(error instanceof Error ? error.message : String(error));
          },
        );
      } else {
        pushRecent(command.id);
        finish();
      }
    } else {
      setValues(nextValues);
      setLabels(nextLabels);
      setQuery('');
      setStepIndex(stepIndex + 1);
    }
  };

  const acceptOption = (option: Option) => {
    acceptValue(option.value, option.label ?? option.value);
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
    const highlighted = view.suggestions[sel];
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
      const entry = view.items[sel];
      if (entry) {
        runEntry(entry);
      }
    } else if (view.kind === 'wizard') {
      const option = view.options[sel];
      if (option) {
        acceptOption(option);
      }
    } else if (view.kind === 'path') {
      acceptPath();
    } else {
      acceptText();
    }
  };

  const back = () => {
    if (!command) {
      closePalette();
      return;
    }
    if (stepIndex > 0) {
      const previousKey = args[stepIndex - 1]?.key;
      if (previousKey) {
        setValues((current) => {
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
      setQuery('');
      setStepIndex(stepIndex - 1);
    } else {
      setCommand(null);
      setQuery('');
    }
  };

  const cycleSel = (delta: number) => {
    setSel((current) => (length === 0 ? 0 : (current + delta + length) % length));
  };

  // Tab fills the buffer with the highlighted directory without submitting, so
  // Enter afterwards commits it. Path-step only.
  const fillPath = () => {
    if (view.kind !== 'path') {
      return;
    }
    const highlighted = view.suggestions[sel];
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

  const crumbLabels = command ? args.slice(0, stepIndex).map((arg) => labels[arg.key] ?? '') : [];

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
  sel: number;
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
  sel: number;
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

function WizardOptions({
  options,
  sel,
  onPick,
}: {
  options: readonly Option[];
  sel: number;
  onPick: (index: number) => void;
}) {
  return (
    <>
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
