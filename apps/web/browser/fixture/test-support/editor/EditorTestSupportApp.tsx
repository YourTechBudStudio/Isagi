import { useAtomValue } from '@effect/atom-react';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useState } from 'react';

import { AppStateProvider } from '../../../../src/lib/state/AppStateProvider.js';
import { revalidate } from '../../../../src/lib/state/policy.js';
import { runApp } from '../../../../src/lib/state/runtime.js';
import { restoreActivePaneFocus } from '../../../../src/lib/workspace/activation.js';
import { surfaceDetailAtom } from '../../../../src/lib/workspace/queries.js';
import {
  activePaneBySurfaceAtom,
  emptyWorkspaceSelection,
  selectWorktree,
  setActiveSurface,
  setSelection,
} from '../../../../src/lib/workspace/store.js';
import { TerminalPresentationProvider } from '../../../../src/lib/workspace/terminal-presentation/TerminalPresentationProvider.js';
import { Surface } from '../../../../src/routes/workspace/Surface.js';
import { createFixtureRegistry } from '../registry.js';
import type { EditorRuntimeControls } from './fake-runtime.js';
import { SURFACE_ID, WORKTREE_ID } from './fake-runtime.js';

const fixtureRegistry = createFixtureRegistry();

/**
 * A test-support harness, not a gallery. It has no picker, no authored state
 * catalogue, and nothing to browse.
 *
 * It exists because four editor behaviours cannot be established by markup at
 * all — the frame-load handover, the header receding at a real computed height,
 * activation across the iframe's own document, and the focus router landing back
 * inside the workbench — and because the container's lifecycle rules (one mount
 * `reuse`, notice lifetime, diagnostics keyed to an incarnation) need effects,
 * a client renderer, and a real app registry, none of which the Node suite has.
 *
 * It mounts the **production** `Surface`, so the kind dispatch, the container,
 * the surface-detail read, the runtime client, and the invalidation are all the real
 * ones. Only the process at the other end of the wire is replaced.
 */
export function EditorTestSupportApp({ runtime }: { readonly runtime: EditorRuntimeControls }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSelection(fixtureRegistry, emptyWorkspaceSelection);
    selectWorktree(fixtureRegistry, 1, WORKTREE_ID);
    setActiveSurface(fixtureRegistry, WORKTREE_ID, SURFACE_ID);
    setReady(true);
  }, []);

  useEffect(() => {
    window.editorTestSupport = {
      ...runtime,
      // Production reconciles a change it did not initiate through the
      // `editor_context_changed` event, which invalidates surface detail. This
      // harness has no event socket, so the invalidation is asked for directly.
      refetchSurface: () => runApp(fixtureRegistry, revalidate(surfaceDetailAtom(SURFACE_ID))),
    };
    return () => {
      delete window.editorTestSupport;
    };
  }, [runtime]);

  if (!ready) return null;

  return (
    <AppStateProvider registry={fixtureRegistry}>
      {/*
          The neighbouring shell pane is a `PtyPane`, which reads the presentation
          cache. Production mounts this provider around the work area for the same
          reason, so the harness is faithful rather than accommodating.
        */}
      <TerminalPresentationProvider
        settings={{
          scrollbackLines: 5_000,
          cache: { idleTtlMinutes: 180, maxHiddenSessions: 8, maxEstimatedBufferMiB: 64 },
        }}
      >
        <Harness />
      </TerminalPresentationProvider>
    </AppStateProvider>
  );
}

const selectFixturePaneId = (activePaneBySurfaceId: Readonly<Record<number, number>>) =>
  activePaneBySurfaceId[SURFACE_ID] ?? null;

function Harness() {
  const activePaneId = useAtomValue(activePaneBySurfaceAtom, selectFixturePaneId);
  const detail = Option.getOrUndefined(
    AsyncResult.value(useAtomValue(surfaceDetailAtom(SURFACE_ID))),
  );

  return (
    <div data-editor-test-support className="flex h-screen flex-col gap-2 bg-canvas p-4">
      {/*
        The one thing the app cannot otherwise offer: the store's own answer to
        "which pane is active", stamped where a test can read it. Activation
        across a cross-document boundary is invisible otherwise.
      */}
      <div data-active-pane-id={activePaneId === null ? '' : String(activePaneId)} />
      {/*
        Stands in for focus-owning chrome closing. It calls the same shared
        router the palette and the drawer call, so the return leg under test is
        the production one.
      */}
      <button
        type="button"
        data-restore-focus
        onClick={() => restoreActivePaneFocus(fixtureRegistry)}
      >
        restore focus
      </button>
      <div className="min-h-0 flex-1">
        {detail ? (
          <Surface
            surface={{
              id: SURFACE_ID,
              title: detail.title,
              paneKinds: ['editor_context', 'terminal_session'],
              attention: 'idle',
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

declare global {
  interface Window {
    editorTestSupport?: EditorRuntimeControls & {
      /** Stand in for the `editor_context_changed` event's invalidation. */
      readonly refetchSurface: () => Promise<void>;
    };
  }
}
