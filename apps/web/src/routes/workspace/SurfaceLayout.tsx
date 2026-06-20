import type { PointerEvent, ReactNode } from 'react';
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
  readonly renderPane: (input: {
    readonly pane: SurfacePane;
    readonly focused: boolean;
    readonly onFocus: () => void;
  }) => ReactNode;
}

export function SurfaceLayout({ detail, renderPane }: SurfaceLayoutProps) {
  const storedPaneId = useWorkspaceStore((state) => state.activePaneBySurfaceId[detail.id]);
  const focusedPaneId = resolveActivePaneId(detail.panes, storedPaneId, detail.activePaneId);
  const previousPaneIds = useRef<ReadonlySet<number> | null>(null);
  const dragState = useRef<DragState | null>(null);
  const [localLayout, setLocalLayout] = useState<SurfaceLayoutNode | null>(null);
  const panesById = useMemo(
    () => new Map(detail.panes.map((pane) => [pane.id, pane] as const)),
    [detail.panes],
  );
  const visibleLayout = localLayout ?? detail.layout;
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

  return (
    <div className="h-full min-h-0">
      {renderLayoutNode({
        node: visibleLayout,
        surfaceId: detail.id,
        panesById,
        renderPane: (pane) =>
          renderPane({
            pane,
            focused: pane.id === focusedPaneId,
            onFocus: () =>
              activatePane({
                worktreeId: detail.worktreeId,
                surfaceId: detail.id,
                paneId: pane.id,
              }),
          }),
        onDragStart: (input) => {
          dragState.current = input;
          setLocalLayout(detail.layout);
        },
        onDragMove: (event) => {
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
            (layout) =>
              setWeightsInLayout(layout ?? detail.layout, drag.nodeId, nextWeights) ?? layout,
          );
        },
        onDragEnd: () => {
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
        },
      })}
    </div>
  );
}

function renderLayoutNode({
  node,
  surfaceId,
  panesById,
  renderPane,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  readonly node: SurfaceLayoutNode;
  readonly surfaceId: number;
  readonly panesById: ReadonlyMap<number, SurfacePane>;
  readonly renderPane: (pane: SurfacePane) => ReactNode;
  readonly onDragStart: (input: DragState) => void;
  readonly onDragMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}): ReactNode {
  if (node.kind === 'leaf') {
    const pane = panesById.get(node.paneId);
    if (!pane) return null;
    return (
      <div className="flex h-full min-h-0 min-w-0" style={{ flex: '1 1 0%' }}>
        {renderPane(pane)}
      </div>
    );
  }

  return (
    <div className={`flex h-full min-h-0 min-w-0 ${node.axis === 'row' ? 'flex-row' : 'flex-col'}`}>
      {node.children.map((child, index) => (
        <FragmentWithDivider
          key={child.nodeId}
          child={child}
          index={index}
          split={node}
          surfaceId={surfaceId}
          panesById={panesById}
          renderPane={renderPane}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
        />
      ))}
    </div>
  );
}

function FragmentWithDivider({
  child,
  index,
  split,
  surfaceId,
  panesById,
  renderPane,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  readonly child: SurfaceLayoutNode;
  readonly index: number;
  readonly split: Extract<SurfaceLayoutNode, { readonly kind: 'split' }>;
  readonly surfaceId: number;
  readonly panesById: ReadonlyMap<number, SurfacePane>;
  readonly renderPane: (pane: SurfacePane) => ReactNode;
  readonly onDragStart: (input: DragState) => void;
  readonly onDragMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}) {
  return (
    <>
      <div
        className="flex min-h-0 min-w-0"
        style={{
          flexGrow: split.weights[index] ?? 1,
          flexShrink: 1,
          flexBasis: 0,
        }}
      >
        {renderLayoutNode({
          node: child,
          surfaceId,
          panesById,
          renderPane,
          onDragStart,
          onDragMove,
          onDragEnd,
        })}
      </div>
      {index < split.children.length - 1 ? (
        <SplitDivider
          split={split}
          dividerIndex={index}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
        />
      ) : null}
    </>
  );
}

function SplitDivider({
  split,
  dividerIndex,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  readonly split: Extract<SurfaceLayoutNode, { readonly kind: 'split' }>;
  readonly dividerIndex: number;
  readonly onDragStart: (input: DragState) => void;
  readonly onDragMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}) {
  const axisClass =
    split.axis === 'row' ? 'w-2 cursor-col-resize px-[3px]' : 'h-2 cursor-row-resize py-[3px]';
  const lineClass =
    split.axis === 'row'
      ? 'h-full w-px group-hover/divider:bg-blue/55 group-data-[dragging=true]/divider:bg-blue/70'
      : 'h-px w-full group-hover/divider:bg-blue/55 group-data-[dragging=true]/divider:bg-blue/70';

  return (
    <div
      role="separator"
      aria-orientation={split.axis === 'row' ? 'vertical' : 'horizontal'}
      tabIndex={-1}
      data-dragging="false"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const target = event.currentTarget;
        const container = target.parentElement;
        if (!container) return;
        event.preventDefault();
        event.stopPropagation();
        target.setPointerCapture(event.pointerId);
        target.dataset.dragging = 'true';
        const rect = container.getBoundingClientRect();
        const leftWeight = split.weights[dividerIndex] ?? 0;
        const rightWeight = split.weights[dividerIndex + 1] ?? 0;
        onDragStart({
          nodeId: split.nodeId,
          axis: split.axis,
          dividerIndex,
          weights: [...split.weights],
          pairTotal: leftWeight + rightWeight,
          containerWidth: rect.width,
          containerHeight: rect.height,
          startCoordinate: split.axis === 'row' ? event.clientX : event.clientY,
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
      className={`group/divider z-10 flex shrink-0 items-center justify-center touch-none ${axisClass}`}
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
