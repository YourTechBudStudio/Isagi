import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type { EditorContextMetadata, SurfaceDetail, SurfacePane } from '@isagi/contracts';

import {
  useEnsureEditorRuntimeMutation,
  useEditorDiagnosticsQuery,
} from '../../lib/editor/queries.js';
import {
  editorAttemptBanner,
  editorPaneView,
  editorStartIsPending,
  type EditorStartIntent,
} from '../../lib/editor/view.js';
import { classifyRuntimeFailure } from '../../lib/runtime/classify.js';
import { formatRuntimeError } from '../../lib/workspace/runtime-data.js';
import { EditorPane, type EditorDiagnosticsState } from './EditorPane.js';
import { usePaneChromeActions } from './usePaneChromeActions.js';

/**
 * The editor pane's plumbing: the projection in, the runtime operations out.
 *
 * `EditorPane` itself stays entirely props-driven. That split is production
 * architecture, not a fixture accommodation — the pane's job is to render one
 * projection honestly, and every lifetime rule that is easy to get wrong (when
 * an ensure fires, how long a request-local failure lives, which incarnation a
 * diagnostics read belongs to) lives here, in one place, where it can be read.
 */
export function EditorPaneContainer({
  pane,
  editorContext,
  surface,
  focused,
  onFocus,
}: {
  readonly pane: SurfacePane;
  readonly editorContext: EditorContextMetadata;
  readonly surface: SurfaceDetail;
  readonly focused: boolean;
  readonly onFocus: () => void;
}): ReactElement {
  const editorContextId = editorContext.id;
  const activePtyProcessId = editorContext.activePtyProcessId;
  const view = editorPaneView(editorContext);
  const banner = editorAttemptBanner(editorContext);

  const ensure = useEnsureEditorRuntimeMutation({ editorContextId, surfaceId: surface.id });
  const chrome = usePaneChromeActions({
    worktreeId: surface.worktreeId,
    surfaceId: surface.id,
    paneId: pane.id,
  });

  // A failure the runtime never recorded: a dropped connection, a refusal that
  // arrived under the pane, a database fault. It has no home in the projection,
  // so the pane that made the request holds it.
  const [notice, setNotice] = useState<string | null>(null);
  // Which incarnation the open disclosure belongs to, rather than a boolean.
  // A boolean would still read as open on the first render after a replacement
  // and could start a read for the wrong incarnation before any effect closed it.
  const [openForPtyProcessId, setOpenForPtyProcessId] = useState<number | null>(null);

  // Every ensure carries the incarnation it was started against, so a slow
  // response cannot install its notice over a pane that has since moved on.
  const generationRef = useRef(0);
  const start = useCallback(
    (intent: EditorStartIntent) => {
      const generation = ++generationRef.current;
      // The notice describes the *previous* request. Retiring it as the next one
      // starts is what keeps the pane's degraded state current: otherwise a
      // transport failure's notice would still be sitting beside a newer attempt
      // that settled as `editor_launch_failed`, and the pane would report two
      // different failures as though both described the latest try.
      setNotice(null);
      ensure.mutate(
        { intent },
        {
          onError: (error) => {
            if (generationRef.current !== generation) return;
            // `editor_launch_failed` is already the durable attempt record, and
            // the invalidated surface detail renders it as the settled state.
            // Reporting it again from the response would say one fact twice.
            const classified = classifyRuntimeFailure(error);
            if (classified.kind === 'api' && classified.apiError.code === 'editor_launch_failed') {
              return;
            }
            setNotice(formatRuntimeError(error));
          },
        },
      );
    },
    [ensure],
  );

  // One `reuse` per mounted context. Reuse is a no-op once an incarnation is
  // owned, so this is safe; firing it on projection changes instead would be a
  // request loop against a settled state.
  //
  // This is component-lifetime, not global, deduplication. A Strict Mode remount
  // legitimately asks again, and the runtime's own per-worktree lock makes that
  // idempotent — which is why there is no module-level cache here.
  const ensuredRef = useRef<number | null>(null);
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (ensuredRef.current === editorContextId) return;
    ensuredRef.current = editorContextId;
    startRef.current('reuse');
  }, [editorContextId]);

  // A *change* of incarnation invalidates the notice: it described a request
  // against a process that no longer exists.
  //
  // Deliberately skipped on mount. The mount-time `reuse` has already claimed a
  // generation by the time effects settle, and clearing here would silence the
  // one case that matters most — a first launch that failed while the projection
  // still reads `idle`, where `activePtyProcessId` never left `null` and so no
  // change is ever observable.
  const previousPtyProcessIdRef = useRef<number | null>(activePtyProcessId);
  useEffect(() => {
    if (previousPtyProcessIdRef.current === activePtyProcessId) return;
    previousPtyProcessIdRef.current = activePtyProcessId;
    setNotice(null);
    generationRef.current += 1;
  }, [activePtyProcessId]);

  const diagnosticsOpen =
    openForPtyProcessId !== null && openForPtyProcessId === activePtyProcessId;
  const diagnosticsQuery = useEditorDiagnosticsQuery(
    { editorContextId, ptyProcessId: activePtyProcessId },
    { enabled: diagnosticsOpen },
  );

  const diagnostics: EditorDiagnosticsState = !diagnosticsOpen
    ? { kind: 'closed' }
    : diagnosticsQuery.data
      ? { kind: 'loaded', output: diagnosticsQuery.data }
      : diagnosticsQuery.error
        ? { kind: 'failed', detail: formatRuntimeError(diagnosticsQuery.error) }
        : { kind: 'loading' };

  const onToggleDiagnostics = useCallback(() => {
    setOpenForPtyProcessId((current) =>
      current !== null && current === activePtyProcessId ? null : activePtyProcessId,
    );
  }, [activePtyProcessId]);

  const refetchDiagnostics = diagnosticsQuery.refetch;
  const onRetryDiagnostics = useCallback(() => {
    void refetchDiagnostics();
  }, [refetchDiagnostics]);

  return (
    <EditorPane
      title={pane.title}
      view={view}
      banner={banner}
      notice={notice}
      activePtyProcessId={activePtyProcessId}
      hasDiagnostics={editorContext.hasDiagnostics}
      focused={focused}
      onFocus={onFocus}
      starting={ensure.isPending && editorStartIsPending(view, ensure.variables?.intent ?? null)}
      onStart={start}
      diagnostics={diagnostics}
      onToggleDiagnostics={onToggleDiagnostics}
      onRetryDiagnostics={onRetryDiagnostics}
      actions={{
        onSplitRight: chrome.onSplitRight,
        onSplitDown: chrome.onSplitDown,
        onDelete: chrome.onDelete,
        locked: chrome.locked,
        menuDeletePending: chrome.menuDeletePending,
        clusterDeletePending: chrome.clusterDeletePending,
        deleteError: chrome.deleteError,
        onDeleteResultDismissed: chrome.onDeleteResultDismissed,
      }}
      focusTarget={{ surfaceId: surface.id, paneId: pane.id }}
    />
  );
}
