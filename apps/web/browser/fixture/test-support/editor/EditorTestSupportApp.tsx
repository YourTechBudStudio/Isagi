import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { queryClient } from '../../../../src/lib/query/client.js';
import { restoreActivePaneFocus } from '../../../../src/lib/workspace/activation.js';
import { useSurfaceDetailQuery } from '../../../../src/lib/workspace/queries.js';
import { surfaceDetailQueryKey } from '../../../../src/lib/workspace/query-keys.js';
import { emptyWorkspaceSelection, useWorkspaceStore } from '../../../../src/lib/workspace/store.js';
import { TerminalPresentationProvider } from '../../../../src/lib/workspace/terminal-presentation/TerminalPresentationProvider.js';
import { Surface } from '../../../../src/routes/workspace/Surface.js';
import type { EditorRuntimeControls } from './fake-runtime.js';
import { SURFACE_ID, WORKTREE_ID } from './fake-runtime.js';

/**
 * A test-support harness, not a gallery. It has no picker, no authored state
 * catalogue, and nothing to browse.
 *
 * It exists because four editor behaviours cannot be established by markup at
 * all — the frame-load handover, the header receding at a real computed height,
 * activation across the iframe's own document, and the focus router landing back
 * inside the workbench — and because the container's lifecycle rules (one mount
 * `reuse`, notice lifetime, diagnostics keyed to an incarnation) need effects,
 * a client renderer, and a real query cache, none of which the Node suite has.
 *
 * It mounts the **production** `Surface`, so the kind dispatch, the container,
 * the query observer, the runtime client, and the invalidation are all the real
 * ones. Only the process at the other end of the wire is replaced.
 */
export function EditorTestSupportApp({ runtime }: { readonly runtime: EditorRuntimeControls }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const store = useWorkspaceStore.getState();
    store.setSelection(emptyWorkspaceSelection);
    store.selectWorktree(1, WORKTREE_ID);
    store.setActiveSurface(WORKTREE_ID, SURFACE_ID);
    setReady(true);
  }, []);

  useEffect(() => {
    window.editorTestSupport = {
      ...runtime,
      // Store-side, so it lives here rather than in the fake runtime: there is
      // exactly one publisher of this object, following the command-palette
      // harness.
      clearActivePane: () => useWorkspaceStore.setState({ activePaneBySurfaceId: {} }),
      // Production reconciles a change it did not initiate through the
      // `editor_context_changed` event, which invalidates surface detail. This
      // harness has no event socket, so the invalidation is asked for directly.
      refetchSurface: () =>
        queryClient.invalidateQueries({ queryKey: surfaceDetailQueryKey(SURFACE_ID) }),
    };
    return () => {
      delete window.editorTestSupport;
    };
  }, [runtime]);

  if (!ready) return null;

  return (
    <QueryClientProvider client={queryClient}>
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
    </QueryClientProvider>
  );
}

function Harness() {
  const activePaneId = useWorkspaceStore(
    (state) => state.activePaneBySurfaceId[SURFACE_ID] ?? null,
  );
  const detail = useSurfaceDetailQuery(SURFACE_ID);

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
      <button type="button" data-restore-focus onClick={() => restoreActivePaneFocus()}>
        restore focus
      </button>
      <div className="min-h-0 flex-1">
        {detail.data ? (
          <Surface
            surface={{
              id: SURFACE_ID,
              title: detail.data.title,
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
      /**
       * Put the store back to "no pane chosen". A real browser focuses the
       * loaded frame, which is itself one of the activation paths under test,
       * so an assertion needs a cleared starting point to be a transition.
       */
      readonly clearActivePane: () => void;
      /** Stand in for the `editor_context_changed` event's invalidation. */
      readonly refetchSurface: () => Promise<void>;
    };
  }
}
