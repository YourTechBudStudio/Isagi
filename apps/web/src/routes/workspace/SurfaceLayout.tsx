import type { CSSProperties, PointerEvent, ReactNode, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { SurfaceDetail, SurfaceLayoutNode, SurfacePane } from '@isagi/contracts';

import { ptyCopy } from '../../copy/index.js';
import { activatePane, syncActivePaneFromSurfaceDetail } from '../../lib/workspace/activation.js';
import {
  resolveActivePaneId,
  resolvePaneFocusAfterDetailChange,
} from '../../lib/workspace/model.js';
import { setSplitWeightsFromSurface } from '../../lib/workspace/queries.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';

const MIN_PANE_SIZE_PX = 160;

interface SurfaceLayoutProps {
  readonly detail: SurfaceDetail;
  readonly locked?: boolean | undefined;
  readonly renderPane: (input: {
    readonly pane: SurfacePane;
    readonly focused: boolean;
    readonly onFocus: () => void;
  }) => ReactNode;
}

/** A node's rectangle as fractions (0..1) of the surface container. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface DividerGeom {
  readonly key: string;
  readonly nodeId: string;
  readonly axis: 'row' | 'column';
  readonly dividerIndex: number;
  readonly weights: readonly number[];
  /** The owning split's rect — its axis pixel span drives drag math. */
  readonly rect: Rect;
  /** Boundary position along the split axis, as a container fraction (0..1). */
  readonly position: number;
}

/**
 * Renders a surface's panes from its layout tree. Panes are a flat, `pane.id`-keyed
 * list positioned by geometry derived from the weights — the tree controls geometry,
 * never React identity. This is deliberate: nesting pane components in the tree DOM
 * made a pane remount whenever a split wrapped it (its key changed), tearing down and
 * reclaiming its PTY attachment. A flat keyed list keeps each pane mounted across
 * restructures. Dividers are an absolutely-positioned overlay over the inter-pane gutters.
 */
export function SurfaceLayout({ detail, locked = false, renderPane }: SurfaceLayoutProps) {
  const storedPaneId = useWorkspaceStore((state) => state.activePaneBySurfaceId[detail.id]);
  const focusedPaneId = resolveActivePaneId(detail.panes, storedPaneId, detail.activePaneId);
  const previousPaneIds = useRef<ReadonlySet<number> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<DragState | null>(null);
  const [localLayout, setLocalLayout] = useState<SurfaceLayoutNode | null>(null);
  const visibleLayout = localLayout ?? detail.layout;
  const geometry = useMemo(() => computeLayoutGeometry(visibleLayout), [visibleLayout]);
  const layoutDiagnostics = useMemo(
    () => collectLayoutDiagnostics(detail.layout, detail.panes),
    [detail.layout, detail.panes],
  );

  useEffect(() => {
    const nextFocusedPaneId = resolvePaneFocusAfterDetailChange({
      panes: detail.panes,
      storedPaneId,
      detailActivePaneId: detail.activePaneId,
      previousPaneIds: previousPaneIds.current,
    });
    previousPaneIds.current = new Set(detail.panes.map((pane) => pane.id));
    if (nextFocusedPaneId !== null) {
      syncActivePaneFromSurfaceDetail({
        worktreeId: detail.worktreeId,
        surfaceId: detail.id,
        panes: detail.panes,
        detailActivePaneId: detail.activePaneId,
        preferredPaneId: nextFocusedPaneId,
      });
    }
  }, [detail.id, detail.worktreeId, detail.panes, detail.activePaneId, storedPaneId]);

  useEffect(() => {
    for (const paneId of layoutDiagnostics.missingPaneIds) {
      console.warn('[surface] layout leaf references missing pane', {
        surfaceId: detail.id,
        paneId,
      });
    }
    for (const paneId of layoutDiagnostics.unplacedPaneIds) {
      console.warn('[surface] pane is absent from layout tree', {
        surfaceId: detail.id,
        paneId,
      });
    }
  }, [detail.id, layoutDiagnostics]);

  if (detail.panes.length === 0) {
    return (
      <div className="grid h-full place-items-center rounded-md border border-line/20 bg-elevated/50 backdrop-blur-sm">
        <span className="font-mono text-[12px] text-fg-subtle">{ptyCopy.emptySurface}</span>
      </div>
    );
  }

  const startDrag = (input: DragState) => {
    dragState.current = input;
    setLocalLayout(detail.layout);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragState.current;
    if (!drag) return;
    const axisLength = drag.axis === 'row' ? drag.containerWidth : drag.containerHeight;
    if (axisLength <= 0) return;
    const coordinate = drag.axis === 'row' ? event.clientX : event.clientY;
    const deltaWeight = (coordinate - drag.startCoordinate) / axisLength;
    const nextWeights = resizeAdjacentWeights({
      weights: drag.weights,
      dividerIndex: drag.dividerIndex,
      deltaWeight,
      minWeight: Math.min(MIN_PANE_SIZE_PX / axisLength, drag.pairTotal / 2),
    });
    dragState.current = { ...drag, latestWeights: nextWeights };
    setLocalLayout(
      (layout) => setWeightsInLayout(layout ?? detail.layout, drag.nodeId, nextWeights) ?? layout,
    );
  };
  const endDrag = () => {
    const drag = dragState.current;
    dragState.current = null;
    if (!drag) return;
    const weights = drag.latestWeights ?? drag.weights;
    void setSplitWeightsFromSurface({
      surfaceId: detail.id,
      weights: { nodeId: drag.nodeId, weights },
    })
      .catch((error: unknown) => {
        console.warn('[surface] split resize commit failed', {
          surfaceId: detail.id,
          nodeId: drag.nodeId,
          error,
        });
      })
      .finally(() => {
        setLocalLayout(null);
      });
  };

  return (
    <div ref={containerRef} className="relative h-full min-h-0 min-w-0">
      {detail.panes.map((pane) => {
        const rect = geometry.paneRects.get(pane.id);
        if (!rect) {
          return null;
        }
        return (
          <div key={pane.id} className="absolute flex min-h-0 min-w-0 p-1" style={rectStyle(rect)}>
            {renderPane({
              pane,
              focused: pane.id === focusedPaneId,
              onFocus: () =>
                activatePane({
                  worktreeId: detail.worktreeId,
                  surfaceId: detail.id,
                  paneId: pane.id,
                }),
            })}
          </div>
        );
      })}
      {locked
        ? null
        : geometry.dividers.map((divider) => (
            <SplitDivider
              key={divider.key}
              divider={divider}
              containerRef={containerRef}
              onDragStart={startDrag}
              onDragMove={moveDrag}
              onDragEnd={endDrag}
            />
          ))}
    </div>
  );
}

function rectStyle(rect: Rect): CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
}

function SplitDivider({
  divider,
  containerRef,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  readonly divider: DividerGeom;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly onDragStart: (input: DragState) => void;
  readonly onDragMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}) {
  const isRow = divider.axis === 'row';
  const style: CSSProperties = isRow
    ? {
        left: `${divider.position * 100}%`,
        top: `${divider.rect.y * 100}%`,
        height: `${divider.rect.h * 100}%`,
        width: '8px',
        transform: 'translateX(-50%)',
      }
    : {
        top: `${divider.position * 100}%`,
        left: `${divider.rect.x * 100}%`,
        width: `${divider.rect.w * 100}%`,
        height: '8px',
        transform: 'translateY(-50%)',
      };
  const lineClass = isRow
    ? 'h-full w-px group-hover/divider:bg-blue/55 group-data-[dragging=true]/divider:bg-blue/70'
    : 'h-px w-full group-hover/divider:bg-blue/55 group-data-[dragging=true]/divider:bg-blue/70';

  return (
    <div
      role="separator"
      aria-orientation={isRow ? 'vertical' : 'horizontal'}
      tabIndex={-1}
      data-dragging="false"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const container = containerRef.current;
        if (!container) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = 'true';
        const rect = container.getBoundingClientRect();
        const leftWeight = divider.weights[divider.dividerIndex] ?? 0;
        const rightWeight = divider.weights[divider.dividerIndex + 1] ?? 0;
        onDragStart({
          nodeId: divider.nodeId,
          axis: divider.axis,
          dividerIndex: divider.dividerIndex,
          weights: [...divider.weights],
          pairTotal: leftWeight + rightWeight,
          // The split occupies only a fraction of the container along its axis;
          // scale by that fraction so a px drag maps to the right weight delta.
          containerWidth: rect.width * divider.rect.w,
          containerHeight: rect.height * divider.rect.h,
          startCoordinate: isRow ? event.clientX : event.clientY,
        });
      }}
      onPointerMove={onDragMove}
      onPointerUp={(event) => {
        event.currentTarget.dataset.dragging = 'false';
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        onDragEnd();
      }}
      onPointerCancel={(event) => {
        event.currentTarget.dataset.dragging = 'false';
        onDragEnd();
      }}
      className={`group/divider absolute z-10 flex items-center justify-center touch-none ${
        isRow ? 'cursor-col-resize' : 'cursor-row-resize'
      }`}
      style={style}
    >
      <span
        aria-hidden
        className={`rounded-full bg-line/20 transition-colors duration-micro ease-expo ${lineClass}`}
      />
    </div>
  );
}

interface DragState {
  readonly nodeId: string;
  readonly axis: 'row' | 'column';
  readonly dividerIndex: number;
  readonly weights: readonly number[];
  readonly pairTotal: number;
  readonly containerWidth: number;
  readonly containerHeight: number;
  readonly startCoordinate: number;
  readonly latestWeights?: readonly number[] | undefined;
}

/**
 * Walks the layout tree once, producing each pane's rectangle and each split's
 * divider geometry as container fractions. Weights are treated as proportions of
 * their split; a degenerate (all-zero) split falls back to equal shares.
 */
function computeLayoutGeometry(layout: SurfaceLayoutNode): {
  readonly paneRects: ReadonlyMap<number, Rect>;
  readonly dividers: readonly DividerGeom[];
} {
  const paneRects = new Map<number, Rect>();
  const dividers: DividerGeom[] = [];

  const walk = (node: SurfaceLayoutNode, rect: Rect) => {
    if (node.kind === 'leaf') {
      paneRects.set(node.paneId, rect);
      return;
    }
    const sum = node.weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
    let cursor = node.axis === 'row' ? rect.x : rect.y;
    node.children.forEach((child, index) => {
      const fraction =
        sum > 0 ? Math.max(0, node.weights[index] ?? 0) / sum : 1 / node.children.length;
      const childRect: Rect =
        node.axis === 'row'
          ? { x: cursor, y: rect.y, w: rect.w * fraction, h: rect.h }
          : { x: rect.x, y: cursor, w: rect.w, h: rect.h * fraction };
      walk(child, childRect);
      cursor += node.axis === 'row' ? rect.w * fraction : rect.h * fraction;
      if (index < node.children.length - 1) {
        dividers.push({
          key: `${node.nodeId}:${index}`,
          nodeId: node.nodeId,
          axis: node.axis,
          dividerIndex: index,
          weights: node.weights,
          rect,
          position: cursor,
        });
      }
    });
  };

  walk(layout, { x: 0, y: 0, w: 1, h: 1 });
  return { paneRects, dividers };
}

function resizeAdjacentWeights({
  weights,
  dividerIndex,
  deltaWeight,
  minWeight,
}: {
  readonly weights: readonly number[];
  readonly dividerIndex: number;
  readonly deltaWeight: number;
  readonly minWeight: number;
}) {
  const next = [...weights];
  const left = weights[dividerIndex] ?? 0;
  const right = weights[dividerIndex + 1] ?? 0;
  const pairTotal = left + right;
  const nextLeft = clamp(left + deltaWeight, minWeight, pairTotal - minWeight);
  next[dividerIndex] = roundWeight(nextLeft);
  next[dividerIndex + 1] = roundWeight(pairTotal - nextLeft);
  return next;
}

function setWeightsInLayout(
  layout: SurfaceLayoutNode,
  nodeId: string,
  weights: readonly number[],
): SurfaceLayoutNode | null {
  if (layout.nodeId === nodeId) {
    return layout.kind === 'split' ? { ...layout, sizing: 'manual', weights } : null;
  }
  if (layout.kind === 'leaf') return layout;
  let changed = false;
  const children = layout.children.map((child) => {
    const next = setWeightsInLayout(child, nodeId, weights);
    if (!next) return child;
    changed = changed || next !== child;
    return next;
  });
  return changed ? { ...layout, children } : layout;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundWeight(weight: number) {
  return Math.round(weight * 1_000_000) / 1_000_000;
}

function collectLayoutDiagnostics(
  layout: SurfaceLayoutNode,
  panes: readonly SurfacePane[],
): {
  readonly missingPaneIds: readonly number[];
  readonly unplacedPaneIds: readonly number[];
} {
  const placedPaneIds = new Set<number>();
  const missingPaneIds: number[] = [];
  const paneIds = new Set(panes.map((pane) => pane.id));

  visitLayoutLeaves(layout, (paneId) => {
    placedPaneIds.add(paneId);
    if (!paneIds.has(paneId)) {
      missingPaneIds.push(paneId);
    }
  });

  return {
    missingPaneIds,
    unplacedPaneIds: panes.map((pane) => pane.id).filter((paneId) => !placedPaneIds.has(paneId)),
  };
}

function visitLayoutLeaves(layout: SurfaceLayoutNode, visit: (paneId: number) => void) {
  if (layout.kind === 'leaf') {
    visit(layout.paneId);
    return;
  }
  layout.children.forEach((child) => visitLayoutLeaves(child, visit));
}
