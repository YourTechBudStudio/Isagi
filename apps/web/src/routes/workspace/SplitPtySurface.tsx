import type { ReactNode } from 'react';
import { useState } from 'react';

/**
 * Shared auto-split shell for split-PTY surfaces.
 *
 * Agent sessions and terminal shells are the same layout problem: panes split
 * the canvas, one pane is visually focused, and the rest stay visible but quiet.
 * Drag/reorder/resize/persistence will replace this auto-split internals in one
 * place during the split-layout slice.
 */
export function SplitPtySurface<TPane extends { readonly id: string }>({
  panes,
  renderHeader,
  renderBody,
}: {
  panes: readonly TPane[];
  renderHeader: (pane: TPane) => ReactNode;
  renderBody: (pane: TPane) => ReactNode;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(panes[0]?.id ?? null);

  return (
    <div className="flex h-full gap-2">
      {panes.map((pane) => (
        <button
          type="button"
          key={pane.id}
          onClick={() => setFocusedId(pane.id)}
          className={`relative min-w-0 flex-1 cursor-default overflow-auto rounded-md border bg-elevated/50 px-4 pt-8 pb-3.5 text-left backdrop-blur-sm transition-opacity duration-ui ease-expo ${
            pane.id === focusedId ? 'border-blue/40 opacity-100' : 'border-line/20 opacity-50'
          }`}
        >
          <span className="absolute top-2.5 left-3 flex items-center gap-2">
            {renderHeader(pane)}
          </span>
          <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg-muted">
            {renderBody(pane)}
          </pre>
        </button>
      ))}
    </div>
  );
}
