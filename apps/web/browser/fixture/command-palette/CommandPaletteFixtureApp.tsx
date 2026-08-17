import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Overline } from '../../../src/components/Overline.js';
import { paletteCopy } from '../../../src/copy/index.js';
import { GROUP_ORDER } from '../../../src/lib/palette/groups.js';
import { filterEntries, recencyView } from '../../../src/lib/palette/model.js';
import type { PaletteEntry } from '../../../src/lib/palette/types.js';
import { modKey } from '../../../src/lib/platform.js';
import { EntryList, Tip } from '../../../src/routes/workspace/CommandPaletteViews.js';
import { fixtureCommandEntries, neighbourEntries, VARIANTS, type FixtureVariant } from './seed.js';

/**
 * The `Commands` palette group, in production styling, over hardcoded catalog
 * data and local selection state.
 *
 * What is production here: `EntryList` and `Tip` (the real rows, header, icon
 * tones, and tip bar), `filterEntries` and `recencyView` (so the empty-query
 * three-per-group cap and the substring match are the real ones), `GROUP_ORDER`,
 * and every string the rows render. What is mocked: the catalog, and what
 * selecting a row does — a startable row records `run:<name>` then `open:<name>`
 * instead of calling the runtime and opening the drawer.
 *
 * The palette shell is a stand-in rather than the production `CommandPalette`,
 * because mounting the real one would drag in the palette machine, the workspace
 * store, and the runtime client — the integration phase 05 is for. Its container,
 * header, body, and tip bar mirror the production classes exactly, so density is
 * judged at the width and padding the palette actually has.
 */
export function CommandPaletteFixtureApp() {
  const [variantId, setVariantId] = useState(VARIANTS[0]!.id);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [actions, setActions] = useState<readonly string[]>([]);

  const variant: FixtureVariant = VARIANTS.find((item) => item.id === variantId) ?? VARIANTS[0]!;

  // Recording is a ref so the entry closures stay stable and can be awaited
  // without a stale-state read reordering what they logged.
  const record = useCallback((action: string) => {
    setActions((previous) => [...previous, action]);
  }, []);

  const entries = useMemo(() => {
    const all = [...neighbourEntries(record), ...fixtureCommandEntries(variant, record)];
    // Assembly order in production is group order; the palette's views rely on
    // it for contiguous headers, so the fixture has to earn its headers the
    // same way rather than by rendering the groups in the order it declared them.
    return all.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }, [variant, record]);

  const visible = useMemo(
    // Empty query goes through the real recency view, so the group is capped at
    // three exactly as it will be in the app. Typing lifts the cap, which is the
    // only way a worktree with many commands is actually usable.
    () => (query ? filterEntries(entries, query) : recencyView(entries, [])),
    [entries, query],
  );

  useEffect(() => {
    setSel(0);
  }, [variantId, query]);

  const pick = useCallback(
    (index: number) => {
      const entry: PaletteEntry | undefined = visible[index];
      if (!entry) return;
      setSel(index);
      void entry.run();
    },
    [visible],
  );

  const selectVariant = useCallback((id: string) => {
    setVariantId(id);
    setQuery('');
    setActions([]);
  }, []);

  // Playwright drives the page through this rather than through the control
  // buttons, so a spec never depends on the layout of instrumentation chrome.
  const apiRef = useRef({ selectVariant, actions, pick });
  apiRef.current = { selectVariant, actions, pick };
  useEffect(() => {
    window.commandPaletteFixture = {
      selectVariant: (id) => apiRef.current.selectVariant(id),
      actions: () => [...apiRef.current.actions],
      reset: () => apiRef.current.selectVariant(VARIANTS[0]!.id),
    };
    return () => {
      delete window.commandPaletteFixture;
    };
  }, []);

  return (
    <div className="relative z-1 min-h-screen px-8 py-7 text-fg">
      <header className="mb-5">
        <h1 className="font-display text-[19px] font-bold tracking-[-0.03em]">
          Commands in the palette — fixture
        </h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-fg-muted">
          One row per configured command in the active worktree, shown between Workflows and This
          worktree. Startable rows launch and hand off to command details; running rows only open
          details.
        </p>
      </header>

      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {VARIANTS.map((option) => (
          <button
            key={option.id}
            type="button"
            data-variant-option={option.id}
            aria-pressed={option.id === variantId}
            onClick={() => selectVariant(option.id)}
            className={`rounded-sm border px-2.5 py-1 font-mono text-[11px] transition duration-micro ease-expo ${
              option.id === variantId
                ? 'border-line/45 bg-white/8 text-fg'
                : 'border-line/20 bg-white/3 text-fg-subtle hover:bg-white/6'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p data-variant-note className="mb-6 max-w-3xl text-[12px] leading-relaxed text-fg-subtle">
        {variant.note}
      </p>

      <div className="flex flex-wrap items-start gap-8">
        {/* The palette container, header, body, and tip bar mirror
            CommandPalette.tsx. Kept in sync by eye until phase 05 mounts the
            real one; if these drift, this fixture is judging a palette the app
            does not have. */}
        <div
          data-fixture-palette
          className="h-fit w-145 max-w-full overflow-hidden rounded-lg border border-line/30 bg-elevated/85 shadow-lift outline-none backdrop-blur-2xl"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSel((index) => (visible.length === 0 ? 0 : (index + 1) % visible.length));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSel((index) =>
                visible.length === 0 ? 0 : (index - 1 + visible.length) % visible.length,
              );
            } else if (event.key === 'Enter') {
              event.preventDefault();
              pick(sel);
            }
          }}
        >
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line/16 px-4 py-3.5">
            <span className="font-mono text-[13px] text-blue">{modKey}K</span>
            <input
              data-fixture-query
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={paletteCopy.placeholders.command}
              className="min-w-30 flex-1 bg-transparent font-sans text-[15px] text-fg outline-none placeholder:text-fg-subtle"
            />
          </div>
          <div className="max-h-[46vh] overflow-y-auto p-1.5">
            <EntryList items={visible} sel={sel} onPick={pick} />
          </div>
          <Tip mode="list" />
        </div>

        <div className="w-72 shrink-0">
          <Overline className="mb-2">Test instrumentation</Overline>
          <p className="mb-2 font-mono text-[10.5px] leading-relaxed text-fg-subtle opacity-70">
            {'// not shipped UI — what a selection recorded'}
          </p>
          <ol
            data-fixture-actions
            className="space-y-1 rounded-md border border-line/18 bg-scrim/28 p-2 font-mono text-[10.5px] text-fg-muted"
          >
            {actions.length === 0 ? (
              <li className="text-fg-subtle opacity-60">nothing selected yet</li>
            ) : (
              actions.map((action, index) => (
                <li key={`${action}-${index}`} data-fixture-action={action}>
                  {index + 1}. {action}
                </li>
              ))
            )}
          </ol>
        </div>
      </div>
    </div>
  );
}

declare global {
  interface Window {
    commandPaletteFixture?: {
      selectVariant: (id: string) => void;
      actions: () => readonly string[];
      reset: () => void;
    };
  }
}
