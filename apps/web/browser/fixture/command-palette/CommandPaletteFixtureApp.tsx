import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { queryClient } from '../../../src/lib/query/client.js';
import { RuntimeLocalityContext, type RuntimeLocality } from '../../../src/lib/runtime/locality.js';
import { registerPaneFocusTarget } from '../../../src/lib/workspace/activation.js';
import { worktreeCommandsQueryKey } from '../../../src/lib/workspace/query-keys.js';
import { emptyWorkspaceSelection, useWorkspaceStore } from '../../../src/lib/workspace/store.js';
import { CommandPalette } from '../../../src/routes/workspace/CommandPalette.js';
import { StatusStrip } from '../../../src/routes/workspace/StatusStrip.js';
import { WorkbenchDrawer } from '../../../src/routes/workspace/WorkbenchDrawer.js';
import type { CommandPaletteRuntimeControls } from './fake-runtime.js';
import { FIXTURE_ORIGIN, FIXTURE_PANES } from './seed.js';

/**
 * The command-palette fixture: the production `CommandPalette` and
 * `WorkbenchDrawer`, with a fake runtime behind them (see {@link ./fake-runtime}).
 *
 * Phase 01's forked palette shell, its hardcoded catalog, and its `run:`/`open:`
 * recording are gone. Anything that could still be toggled here would be a second
 * definition of how the palette behaves, and the whole point of this page is that
 * the seams between the palette, the drawer, the focus router, and the query
 * observer only exist when the real components are mounted together.
 *
 * What the page adds is the one thing the app cannot otherwise offer: registered
 * pane focus targets that count their invocations, so "the drawer kept focus" and
 * "the pane got focus back" are observable facts rather than the absence of
 * evidence.
 */
export function CommandPaletteFixtureApp({
  runtime,
}: {
  readonly runtime: CommandPaletteRuntimeControls;
}) {
  const [ready, setReady] = useState(false);
  // Locality is a client-side capability, not something the runtime serves, so
  // it is steered here rather than through the fake runtime. Phase 05 derives
  // the production value; until then the fixture is the only place a `local`
  // value exists at all.
  const [locality, setLocality] = useState<RuntimeLocality>('local');
  // Counted through a ref so the stand-in focus closures stay stable and a
  // re-render cannot lose a count that a queued animation frame just recorded.
  const paneFocusCounts = useRef<Record<number, number>>({});

  useEffect(() => {
    // Both sides of a worktree switch are seeded, not just the one the page
    // opens on: the destination's active surface and pane have to resolve for
    // `restoreActivePaneFocus()` to schedule anything at all, and a suppression
    // assertion against a request that was never going to fire proves nothing.
    const store = useWorkspaceStore.getState();
    for (const place of FIXTURE_PANES) {
      store.setActiveSurface(place.worktreeId, place.surfaceId);
      store.setActivePane(place.surfaceId, place.paneId);
    }
    store.selectWorktree(FIXTURE_ORIGIN.projectId, FIXTURE_ORIGIN.worktreeId);
    setReady(true);
  }, []);

  useEffect(() => {
    window.commandPaletteFixture = {
      ...runtime,
      setActiveWorktree: (worktreeId) => {
        const store = useWorkspaceStore.getState();
        if (worktreeId === null) {
          store.setSelection(emptyWorkspaceSelection);
          return;
        }
        store.selectWorktree(FIXTURE_ORIGIN.projectId, worktreeId);
      },
      paneFocusCount: (worktreeId) => paneFocusCounts.current[worktreeId] ?? 0,
      setLocality,
      // The palette refetches when it opens, so its specs can seed a catalog and
      // then open. The status strip is always mounted and holds its read, so a
      // spec that changes the catalog behind it needs to say so — this is the
      // fixture standing in for the invalidation a real mutation would cause.
      refetchCommands: (worktreeId = FIXTURE_ORIGIN.worktreeId) =>
        queryClient.invalidateQueries({ queryKey: worktreeCommandsQueryKey(worktreeId) }),
    };
    return () => {
      delete window.commandPaletteFixture;
    };
  }, [runtime]);

  return (
    <QueryClientProvider client={queryClient}>
      <RuntimeLocalityContext.Provider value={locality}>
        {/* `relative` because the drawer is absolutely positioned inside the work
          area in production; without a positioned ancestor it would anchor to the
          viewport and this fixture would be judging a drawer the app never renders. */}
        <div data-fixture-shell className="relative h-screen overflow-hidden bg-canvas text-fg">
          {FIXTURE_PANES.map((place) => (
            <PaneStandIn key={place.paneId} place={place} counts={paneFocusCounts} />
          ))}
          {/* Declared in the production order — the drawer before the palette — so
            the effect flush order this page observes is the app's own. */}
          {ready && (
            <>
              <WorkbenchDrawer />
              <CommandPalette />
              {/* The strip is the always-on surface, so it sits at the foot of the
                work area exactly as the app places it. It shares the drawer's
                catalog query, which is the point: a command's chip and its drawer
                row must never disagree about the same read. */}
              <div data-fixture-strip className="absolute inset-x-0 bottom-0 z-10">
                <StatusStrip />
              </div>
            </>
          )}
        </div>
      </RuntimeLocalityContext.Provider>
    </QueryClientProvider>
  );
}

/**
 * Stands in for a pane's focusable surface. In the app this is a terminal; here
 * it only has to be focusable and to say when it was asked to take focus, which
 * is exactly what the focus router and the scheduler's ownership guard are
 * judged on.
 */
function PaneStandIn({
  place,
  counts,
}: {
  readonly place: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly paneId: number;
  };
  readonly counts: React.RefObject<Record<number, number>>;
}) {
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      registerPaneFocusTarget({
        surfaceId: place.surfaceId,
        paneId: place.paneId,
        focus: () => {
          counts.current[place.worktreeId] = (counts.current[place.worktreeId] ?? 0) + 1;
          elementRef.current?.focus({ preventScroll: true });
        },
      }),
    [counts, place.paneId, place.surfaceId, place.worktreeId],
  );

  return (
    <div
      ref={elementRef}
      tabIndex={-1}
      data-pane-stand-in={place.worktreeId}
      className="absolute inset-0 outline-none"
    />
  );
}

declare global {
  interface Window {
    commandPaletteFixture?: CommandPaletteRuntimeControls & {
      /** Select a worktree, or `null` for the no-active-worktree state. */
      readonly setActiveWorktree: (worktreeId: number | null) => void;
      /** How many times that worktree's pane stand-in was asked to take focus. */
      readonly paneFocusCount: (worktreeId: number) => number;
      /** Client/runtime co-location, which decides whether URLs may be offered. */
      readonly setLocality: (locality: RuntimeLocality) => void;
      /** Force the always-mounted strip to re-read a catalog changed behind it. */
      readonly refetchCommands: (worktreeId?: number) => Promise<void>;
    };
  }
}
