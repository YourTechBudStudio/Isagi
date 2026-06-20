import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef } from 'react';

import type { SurfaceDetail, SurfaceLayoutNode, SurfacePane } from '@isagi/contracts';

import { ptyCopy } from '../../copy/index.js';
import { activatePane, syncActivePaneFromSurfaceDetail } from '../../lib/workspace/activation.js';
import {
  resolveActivePaneId,
  resolvePaneFocusAfterDetailChange,
} from '../../lib/workspace/model.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';

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
  const panesById = useMemo(
    () => new Map(detail.panes.map((pane) => [pane.id, pane] as const)),
    [detail.panes],
  );
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
        node: detail.layout,
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
      })}
    </div>
  );
}

function renderLayoutNode({
  node,
  panesById,
  renderPane,
}: {
  readonly node: SurfaceLayoutNode;
  readonly panesById: ReadonlyMap<number, SurfacePane>;
  readonly renderPane: (pane: SurfacePane) => ReactNode;
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
    <div
      className={`flex h-full min-h-0 min-w-0 gap-2 ${
        node.axis === 'row' ? 'flex-row' : 'flex-col'
      }`}
    >
      {node.children.map((child, index) => (
        <div
          key={child.nodeId}
          className="flex min-h-0 min-w-0"
          style={{
            flexGrow: node.weights[index] ?? 1,
            flexShrink: 1,
            flexBasis: 0,
          }}
        >
          {renderLayoutNode({ node: child, panesById, renderPane })}
        </div>
      ))}
    </div>
  );
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
