import { useState } from 'react';

import { useShortcut, type AppShortcutId } from '../../../src/lib/shortcuts/index.js';

type Runs = Readonly<Partial<Record<AppShortcutId, number>>>;

/**
 * Binds the production keymap entries to counters, for pages that have the surfaces under test (a
 * real xterm, the real editor frame) but not the commands those shortcuts run. The chord, phase,
 * priority and key-ownership guard are the production keymap's; only the command is a counter, so
 * a count says "the app took this key", and no count says "the key was left to the surface".
 *
 * Mounted only on request (`?shortcuts=1`), so no other spec on these pages runs with app
 * shortcuts claiming keys.
 */
export function ShortcutProbe({ ids }: { readonly ids: readonly AppShortcutId[] }) {
  const [runs, setRuns] = useState<Runs>({});
  if (new URLSearchParams(location.search).get('shortcuts') !== '1') return null;
  return (
    <>
      {ids.map((id) => (
        <ShortcutCounter
          key={id}
          id={id}
          onRun={() => setRuns((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }))}
        />
      ))}
      {/* Not an `<output>`: its implicit `status` role would join the page's live regions. */}
      <div hidden data-shortcut-runs>
        {JSON.stringify(runs)}
      </div>
    </>
  );
}

function ShortcutCounter({
  id,
  onRun,
}: {
  readonly id: AppShortcutId;
  readonly onRun: () => void;
}) {
  useShortcut(id, { run: onRun });
  return null;
}
