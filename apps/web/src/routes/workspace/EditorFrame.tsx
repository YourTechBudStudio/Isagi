import { useEffect, useRef, type RefObject } from 'react';

import { editorCopy } from '../../copy/index.js';
import { attachShortcutSource } from '../../lib/shortcuts/index.js';
import { EditorWait } from './EditorWait.js';

/**
 * The embedded workbench, served through the runtime at `/editor/<id>/`. The
 * UI is always loaded from the runtime (the desktop loads it exactly as a
 * browser does), so the frame is same-origin with the app everywhere.
 *
 * There is deliberately no `sandbox` attribute: it cannot confine a same-origin
 * frame that needs `allow-scripts allow-same-origin`, and Code Server's
 * extensions already run code on the runtime host with the user's privileges,
 * so the frame gains no capability from it. The pane never speaks to the frame
 * — no `postMessage` listener — and touches its `contentWindow` for one thing
 * only: reading trusted key input for the app shortcuts that take priority over
 * every surface (Mod+K, the palette). Nothing is written into the frame, and a
 * script inside it cannot trigger an app command, because synthetic events are
 * ignored.
 *
 * The cover is the frame's own load, not the runtime's readiness: the runtime
 * says a probe succeeded, which is a different fact from this document having
 * painted. Its state is owned by the pane, which also needs it to decide whether
 * the header may recede.
 */
export function EditorFrame({
  url,
  title,
  loaded,
  onLoaded,
  onActivate,
  frameRef,
}: {
  readonly url: string;
  readonly title: string;
  readonly loaded: boolean;
  readonly onLoaded: () => void;
  /**
   * Promote this pane to active because the user entered the workbench. Null
   * when it is already active, or when a delete is running against it.
   */
  readonly onActivate: (() => void) | null;
  /**
   * Owned by the pane, which needs the element for two things this component
   * cannot decide alone: detecting entry, and being the destination the focus
   * router lands on when focus-owning chrome closes.
   */
  readonly frameRef: RefObject<HTMLIFrameElement | null>;
}) {
  // Pointer events inside the frame belong to the workbench's own document and
  // never bubble into ours, so the pane's `onPointerDown` cannot see a click
  // into the editor. What our document *does* observe is losing focus to the
  // frame element: the top-level window blurs, and the frame is the active
  // element. Without this, clicking into a workbench leaves another pane marked
  // active and points `Cmd+W` and every pane-scoped command at the wrong pane.
  useEffect(() => {
    if (!onActivate) return;
    const onWindowBlur = () => {
      if (document.activeElement === frameRef.current) onActivate();
    };
    window.addEventListener('blur', onWindowBlur);
    return () => window.removeEventListener('blur', onWindowBlur);
  }, [onActivate]);

  // Every load is a fresh document (Code Server reloads itself), so the shortcut
  // source is attached per load; the previous document's listener went with it.
  const detachShortcuts = useRef<(() => void) | null>(null);
  useEffect(() => () => detachShortcutSource(detachShortcuts), []);
  const onLoad = () => {
    detachShortcutSource(detachShortcuts);
    const frameWindow = frameRef.current?.contentWindow;
    if (frameWindow) {
      try {
        detachShortcuts.current = attachShortcutSource(frameWindow);
      } catch (error) {
        // Only a cross-origin frame can refuse this, and the UI and the editor
        // share the runtime's origin; if that ever breaks, say so instead of
        // leaving Mod+K silently dead inside the editor.
        console.warn('[editor] app shortcuts are unavailable inside the workbench frame', error);
      }
    }
    onLoaded();
  };

  return (
    <div className="relative flex min-h-0 flex-1">
      <iframe
        ref={frameRef}
        src={url}
        title={title}
        allow=""
        referrerPolicy="no-referrer"
        onLoad={onLoad}
        // Tabbing into the workbench focuses the frame element in *our*
        // document, which is a normal focus event; the blur seam above is only
        // needed for the pointer path.
        {...(onActivate ? { onFocus: onActivate } : {})}
        className="h-full w-full border-0 bg-canvas"
      />
      {loaded ? null : (
        <div className="absolute inset-0 grid place-items-center bg-canvas">
          <EditorWait text={editorCopy.frameLoading} />
        </div>
      )}
    </div>
  );
}

function detachShortcutSource(detach: RefObject<(() => void) | null>) {
  try {
    detach.current?.();
  } catch {
    // Best-effort: the document it was attached to may already be gone.
  }
  detach.current = null;
}
