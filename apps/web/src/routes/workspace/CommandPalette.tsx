import { AnimatePresence, motion } from 'motion/react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

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
  const inputRef = useRef<HTMLInputElement>(null);

  // Global hotkeys: Mod+K toggles the palette, Mod+N opens the new-worktree wizard.
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
        openPalette('new-worktree');
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

      const options = computeStepOptions(spec, spec.options(ctx, values), query);
      return { kind: 'wizard' as const, options };
    }
    const items = query ? filterEntries(allEntries, query) : recencyView(allEntries, recents);
    return { kind: 'list' as const, items };
  }, [command, spec, ctx, values, query, allEntries, recents]);

  const length =
    view.kind === 'wizard' ? view.options.length : view.kind === 'list' ? view.items.length : 0;
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
      command.run(nextValues, ctx);
      pushRecent(command.id);
      finish();
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

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSel((current) => (length === 0 ? 0 : (current + 1) % length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSel((current) => (length === 0 ? 0 : (current - 1 + length) % length));
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
          <motion.div
            layout
            initial={{ opacity: 0, y: 6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.985 }}
            transition={surfaceTransition}
            className="h-fit w-145 max-w-full overflow-hidden rounded-lg border border-line/30 bg-elevated/85 shadow-lift backdrop-blur-2xl"
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-line/16 px-4 py-3.5">
              {command ? (
                <>
                  <span className="rounded-md border border-blue/30 bg-blue/10 px-2 py-1 font-mono text-[11.5px] text-blue">
                    {command.label}
                  </span>
                  {crumbLabels.map((label, index) => (
                    <span key={args[index]?.key} className="flex items-center gap-2">
                      <span className="text-[11px] text-fg-subtle">›</span>
                      <span className="rounded-md border border-line/22 bg-white/6 px-2 py-1 font-mono text-[11.5px] text-fg-muted">
                        {label}
                      </span>
                    </span>
                  ))}
                  <span className="text-[11px] text-fg-subtle">›</span>
                  <span className="font-mono text-[10px] tracking-widest text-fg-subtle uppercase">
                    {spec?.label}
                  </span>
                </>
              ) : (
                <span className="font-mono text-[13px] text-blue">{modKey}K</span>
              )}
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={
                  command
                    ? spec?.kind === 'combo'
                      ? 'choose or type a name…'
                      : spec?.kind === 'text'
                        ? (spec.placeholder ?? 'type a value…')
                        : 'choose…'
                    : 'Type a command…'
                }
                className="min-w-30 flex-1 bg-transparent font-sans text-[15px] text-fg outline-none placeholder:text-fg-subtle"
              />
            </div>

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

            <Tip wizard={command !== null} />
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
      {options.map((option, index) => (
        <button
          type="button"
          key={option.value}
          onClick={() => onPick(index)}
          className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left ${
            index === sel ? 'bg-white/8' : 'hover:bg-white/4'
          }`}
        >
          <span className="w-4 text-center font-mono text-[12px] text-fg-subtle">
            {option.create ? '+' : index === sel ? '●' : '○'}
          </span>
          <span
            className={`flex-1 truncate text-[13.5px] ${option.create ? 'text-green' : 'text-fg'}`}
          >
            {option.label ?? option.value}
          </span>
          {option.isDefault && <span className="font-mono text-[10.5px] text-cyan">default</span>}
          {option.hint && (
            <span className="font-mono text-[10.5px] text-fg-subtle">{option.hint}</span>
          )}
        </button>
      ))}
    </>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <p className="px-2.5 pt-2 pb-1 font-mono text-[9.5px] tracking-widest text-fg-subtle uppercase">
      {label}
    </p>
  );
}

function Tip({ wizard }: { wizard: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t border-line/14 px-4 py-2.5 font-mono text-[11px] text-fg-subtle">
      {wizard ? (
        <>
          <span>
            <span className="text-fg-muted">↵</span> accept &amp; next
          </span>
          <span>
            <span className="text-fg-muted">esc</span> back
          </span>
          <span className="ml-auto opacity-70">enter · enter · enter</span>
        </>
      ) : (
        <>
          <span>
            <span className="text-fg-muted">↑↓</span> move
          </span>
          <span>
            <span className="text-fg-muted">↵</span> run
          </span>
          <span>
            <span className="text-fg-muted">esc</span> close
          </span>
          <span className="ml-auto opacity-70">tip: {modKey}K from anywhere</span>
        </>
      )}
    </div>
  );
}
