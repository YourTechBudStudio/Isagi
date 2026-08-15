import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';

import type { RailOrderScope } from '../../lib/workspace/rail-order.js';

/**
 * The seam the rail's rows reach the drag layer through. Split from
 * {@link ./RailDrag} so that file exports only components: the provider owns the
 * behaviour, and this owns the shape of the contract between it and the rows.
 */
/** What a source hands the engine and gets back on drop, opaque to the engine. */
export interface RailDragPayload {
  readonly scope: RailOrderScope;
  /**
   * A flat, non-interactive clone of this row for the travelling preview.
   * Deferred so nothing is built until something is actually picked up, and
   * owned by the row so the overlay never has to re-derive what a row looks like.
   */
  readonly preview: () => ReactNode;
}

export interface RailDragValue {
  /** True for the whole of any rail drag, including one over illegal ground. */
  readonly dragging: boolean;
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  readonly sourceProps: (
    scope: RailOrderScope,
    id: number,
    preview: () => ReactNode,
  ) => Record<string, unknown>;
  readonly pinnedProps: () => Record<string, unknown>;
  /** Classes that take the carried row out of the list without unmounting it. */
  readonly draggedClass: (scope: RailOrderScope, id: number) => string;
  /** The gap-opening transform for a sibling of the row currently in flight. */
  readonly reflowStyle: (scope: RailOrderScope, id: number) => CSSProperties | undefined;
}

export const RailDragContext = createContext<RailDragValue | null>(null);

export function useRailDragLayer(): RailDragValue {
  const value = useContext(RailDragContext);
  if (!value) throw new Error('Rail drag components must render inside <RailDragProvider>');
  return value;
}
