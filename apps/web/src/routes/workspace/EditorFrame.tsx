import { useEffect, type RefObject } from 'react';

import { editorCopy } from '../../copy/index.js';
import { EditorWait } from './EditorWait.js';

/**
 * The embedded workbench, and the only place in Isagi that frames a foreign
 * origin.
 *
 * There is deliberately no `sandbox` attribute: the loopback origin is already
 * distinct from the app's, so `allow-scripts allow-same-origin` would add no
 * confinement while risking the workbench. The pane never speaks to the frame —
 * no `postMessage` listener, no `contentWindow` access — so the containment is
 * one-directional and stated here rather than assumed.
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

  return (
    <div className="relative flex min-h-0 flex-1">
      <iframe
        ref={frameRef}
        src={url}
        title={title}
        allow=""
        referrerPolicy="no-referrer"
        onLoad={onLoaded}
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
