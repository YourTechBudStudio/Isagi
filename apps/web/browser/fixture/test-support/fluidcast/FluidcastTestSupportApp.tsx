import { useAtomValue } from '@effect/atom-react';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useState } from 'react';

import { useFluidcastPresentation } from '../../../../src/lib/fluidcast/presentation.js';
import { AppStateProvider } from '../../../../src/lib/state/AppStateProvider.js';
import { ToastProvider } from '../../../../src/lib/toast/index.js';
import { activateSurface } from '../../../../src/lib/workspace/activation.js';
import { surfaceDetailAtom } from '../../../../src/lib/workspace/queries.js';
import {
  activeSurfaceByWorktreeAtom,
  emptyWorkspaceSelection,
  selectWorktree,
  setActiveSurface,
  setSelection,
  setZen,
  zenAtom,
} from '../../../../src/lib/workspace/store.js';
import { TerminalPresentationProvider } from '../../../../src/lib/workspace/terminal-presentation/TerminalPresentationProvider.js';
import { Surface } from '../../../../src/routes/workspace/Surface.js';
import { useZenEscape } from '../../../../src/routes/workspace/useZenEscape.js';
import { createFixtureRegistry } from '../registry.js';
import {
  FAILED_SURFACE_ID,
  FLUIDCAST_SURFACE_ID,
  OTHER_SURFACE_ID,
  WORKTREE_ID,
  type FluidcastRuntimeControls,
} from './fake-runtime.js';

const fixtureRegistry = createFixtureRegistry();

/**
 * A test-support harness for Fluidcast panes. It mounts the production `Surface` (and so
 * `FluidcastPane` and the real player), `useFluidcastPresentation` and `useZenEscape`, exactly as
 * `WorkspacePage` does, over a fake runtime backed by real Harness sessions.
 *
 * The chrome above the surface is the harness's own: buttons that switch the active surface and
 * zen, the store's answers stamped where a test can read them, and a width control so the pane
 * can be judged at about 50% and 25% of a window.
 */
export function FluidcastTestSupportApp({
  runtime,
}: {
  readonly runtime: FluidcastRuntimeControls;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSelection(fixtureRegistry, emptyWorkspaceSelection);
    selectWorktree(fixtureRegistry, 1, WORKTREE_ID);
    setActiveSurface(fixtureRegistry, WORKTREE_ID, FLUIDCAST_SURFACE_ID);
    setReady(true);
  }, []);

  useEffect(() => {
    window.fluidcastTestSupport = runtime;
    return () => {
      delete window.fluidcastTestSupport;
    };
  }, [runtime]);

  if (!ready) return null;

  return (
    <AppStateProvider registry={fixtureRegistry}>
      <TerminalPresentationProvider
        settings={{
          scrollbackLines: 5_000,
          cache: { idleTtlMinutes: 180, maxHiddenSessions: 8, maxEstimatedBufferMiB: 64 },
        }}
      >
        {/* The production toaster, so a test can tell which failures toast and which do not. */}
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </TerminalPresentationProvider>
    </AppStateProvider>
  );
}

const selectActiveSurface = (bySurface: Readonly<Record<number, number>>) =>
  bySurface[WORKTREE_ID] ?? null;

function Harness() {
  const activeSurfaceId = useAtomValue(activeSurfaceByWorktreeAtom, selectActiveSurface);
  const zen = useAtomValue(zenAtom);
  // `?frame=50` narrows the surface to half the window, so each of its two panes is about 25%.
  const [frame] = useState(() => new URLSearchParams(window.location.search).get('frame') ?? '100');

  useFluidcastPresentation(activeSurfaceId);
  useZenEscape();

  const show = (surfaceId: number) =>
    activateSurface(fixtureRegistry, { worktreeId: WORKTREE_ID, surfaceId });

  return (
    <div className="flex h-screen flex-col gap-2 bg-canvas p-4">
      <div
        data-active-surface-id={activeSurfaceId ?? ''}
        data-zen={zen ? '1' : '0'}
        className="flex gap-2 font-mono text-[11px] text-fg-subtle"
      >
        <button
          type="button"
          data-show-surface={FLUIDCAST_SURFACE_ID}
          onClick={() => show(FLUIDCAST_SURFACE_ID)}
        >
          voice surface
        </button>
        <button
          type="button"
          data-show-surface={OTHER_SURFACE_ID}
          onClick={() => show(OTHER_SURFACE_ID)}
        >
          shell surface
        </button>
        <button
          type="button"
          data-show-surface={FAILED_SURFACE_ID}
          onClick={() => show(FAILED_SURFACE_ID)}
        >
          failed surface
        </button>
        <button type="button" data-zen-on onClick={() => setZen(fixtureRegistry, true)}>
          zen
        </button>
      </div>
      <div className="min-h-0 flex-1" style={{ width: `${frame}%` }}>
        {activeSurfaceId !== null ? <ActiveSurface surfaceId={activeSurfaceId} /> : null}
      </div>
    </div>
  );
}

function ActiveSurface({ surfaceId }: { readonly surfaceId: number }) {
  const detail = Option.getOrUndefined(
    AsyncResult.value(useAtomValue(surfaceDetailAtom(surfaceId))),
  );
  if (!detail) return null;
  return (
    <Surface
      key={surfaceId}
      surface={{
        id: surfaceId,
        title: detail.title,
        paneKinds: surfaceId === OTHER_SURFACE_ID ? [] : ['agent_session'],
        attention: 'idle',
      }}
    />
  );
}

declare global {
  interface Window {
    fluidcastTestSupport?: FluidcastRuntimeControls;
  }
}
