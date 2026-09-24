import { useMemo, useState } from 'react';

import type { WorkflowCheckpointBase, WorkflowCheckpointCounts } from '@isagi/contracts';

import { useWorkflowCheckpointInventory } from '../../../lib/workspace/workflow/queries.js';
import {
  buildCheckpointTree,
  checkpointBaseLabel,
  coveringScopes,
  findTreeNode,
  visibleTreeRows,
  type CheckpointTree,
  type CheckpointTreeNode,
} from './checkpoint-view.js';
import { inspectorCopy } from './copy.js';
import type { DockRow } from './dock.js';
import { Fields } from './DockFields.js';
import { formatBytes } from './format.js';
import { WorkflowCheckpointFileContent } from './WorkflowContentViewer.js';

/**
 * A checkpoint's final files: what an export of it would contain.
 *
 * The same tree in both places it appears. In the dock's `files` tab it is compact, with the chosen
 * file shown beneath it; in the Checkpoints tab it is the middle pane and the chosen file gets the
 * pane beside it, with the export line under that. It is always the resolved inventory, never a
 * layer: which checkpoint first saved a file is not a question this surface answers.
 *
 * The inventory is read to its last page before anything is drawn, because a tree built from part of
 * one would quietly leave files out. Callers key it on the checkpoint: a path chosen in one tree says
 * nothing about another.
 */
export function WorkflowCheckpointFiles({
  runId,
  checkpointId,
  base,
  counts,
  layout,
  aside = null,
}: {
  readonly runId: number;
  readonly checkpointId: string;
  readonly base: WorkflowCheckpointBase;
  readonly counts: WorkflowCheckpointCounts;
  readonly layout: 'compact' | 'panes';
  /** Rendered under the chosen file's details in the `panes` layout: the export line. */
  readonly aside?: React.ReactNode;
}) {
  const inventory = useWorkflowCheckpointInventory(runId, checkpointId);
  const tree = useMemo(
    () => (inventory.data === undefined ? null : buildCheckpointTree(inventory.data)),
    [inventory.data],
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const selected = tree === null || selectedPath === null ? null : findTreeNode(tree, selectedPath);
  const heading = inspectorCopy.checkpointFilesHeading(
    inspectorCopy.checkpointCounts(counts.scopes, counts.files, counts.absences),
    checkpointBaseLabel(base),
  );

  const treePane = (
    <TreeState
      inventory={inventory}
      tree={tree}
      selectedPath={selectedPath}
      collapsed={collapsed}
      onSelect={setSelectedPath}
      onToggle={(path) =>
        setCollapsed((current) => {
          const next = new Set(current);
          if (!next.delete(path)) next.add(path);
          return next;
        })
      }
    />
  );

  const detail =
    selected === null || selected.kind === 'dir' || tree === null ? null : (
      <FileDetail
        runId={runId}
        checkpointId={checkpointId}
        node={selected}
        tree={tree}
        base={base}
        compact={layout === 'compact'}
      />
    );

  if (layout === 'compact') {
    return (
      <div data-checkpoint-files={checkpointId}>
        <p className="mb-1 font-mono text-[11px] text-fg-subtle">{heading}</p>
        <div className="max-h-64 overflow-auto rounded-lg border border-line/22 bg-canvas/45 py-1">
          {treePane}
        </div>
        {detail !== null && <div className="mt-2.5">{detail}</div>}
      </div>
    );
  }

  return (
    <div data-checkpoint-files={checkpointId} className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 flex-none basis-100 flex-col border-r border-line/22">
        <p className="flex-none border-b border-line/18 px-3.5 pt-1.5 pb-2 font-mono text-[11px] text-fg-subtle">
          {heading}
        </p>
        <div className="min-h-0 flex-1 overflow-auto py-1">{treePane}</div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4.5 py-3">
        {detail ?? (
          <p className="font-mono text-[11.5px] text-fg-subtle">
            {inspectorCopy.checkpointSelectHint}
          </p>
        )}
        {aside}
      </div>
    </div>
  );
}

function TreeState({
  inventory,
  tree,
  selectedPath,
  collapsed,
  onSelect,
  onToggle,
}: {
  readonly inventory: ReturnType<typeof useWorkflowCheckpointInventory>;
  readonly tree: CheckpointTree | null;
  readonly selectedPath: string | null;
  readonly collapsed: ReadonlySet<string>;
  readonly onSelect: (path: string) => void;
  readonly onToggle: (path: string) => void;
}) {
  if (inventory.error) {
    return (
      <div className="px-3.5 py-2">
        <p className="text-[12.5px] text-fg-muted">{inspectorCopy.checkpointFilesFailed}</p>
        <button
          type="button"
          onClick={() => void inventory.refetch()}
          className="mt-1.5 rounded-md bg-white/6 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:bg-white/10"
        >
          {inspectorCopy.checkpointFilesRetry}
        </button>
      </div>
    );
  }
  if (tree === null) {
    return (
      <p className="px-3.5 py-2 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.checkpointFilesLoading}
      </p>
    );
  }
  if (tree.roots.length === 0) {
    return (
      <p className="px-3.5 py-2 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.checkpointFilesEmpty}
      </p>
    );
  }
  return (
    <CheckpointFileTree
      tree={tree}
      selectedPath={selectedPath}
      collapsed={collapsed}
      onSelect={onSelect}
      onToggle={onToggle}
    />
  );
}

/**
 * The rows themselves. Every row is a button, so the tree is walked with Tab and opened with Enter
 * or Space like everything else in the inspector.
 */
function CheckpointFileTree({
  tree,
  selectedPath,
  collapsed,
  onSelect,
  onToggle,
}: {
  readonly tree: CheckpointTree;
  readonly selectedPath: string | null;
  readonly collapsed: ReadonlySet<string>;
  readonly onSelect: (path: string) => void;
  readonly onToggle: (path: string) => void;
}) {
  const rows = visibleTreeRows(tree, collapsed);
  return (
    <div
      role="tree"
      aria-label={inspectorCopy.checkpointFilesTab}
      className="font-mono text-[12px]"
    >
      {rows.map(({ node, depth }) => (
        <TreeRow
          key={`${node.kind}:${node.path}`}
          node={node}
          depth={depth}
          selected={node.path === selectedPath && node.kind !== 'dir'}
          open={node.kind === 'dir' && !collapsed.has(node.path)}
          onClick={() => (node.kind === 'dir' ? onToggle(node.path) : onSelect(node.path))}
        />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  open,
  onClick,
}: {
  readonly node: CheckpointTreeNode;
  readonly depth: number;
  readonly selected: boolean;
  readonly open: boolean;
  readonly onClick: () => void;
}) {
  const tone =
    node.kind === 'dir'
      ? 'text-fg'
      : node.kind === 'absent'
        ? 'text-fg-subtle line-through decoration-error/60'
        : 'text-fg-muted';
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={node.kind === 'dir' ? undefined : selected}
      aria-expanded={node.kind === 'dir' ? open : undefined}
      data-checkpoint-row={node.path}
      data-checkpoint-row-kind={node.kind}
      onClick={onClick}
      className={`flex w-full items-baseline gap-2 border-l-2 py-0.5 pr-3.5 text-left whitespace-nowrap transition duration-micro ease-expo ${
        selected ? 'border-l-blue bg-blue/10' : 'border-l-transparent hover:bg-elevated/60'
      }`}
      style={{ paddingLeft: 14 + depth * 14 }}
    >
      {node.kind === 'dir' && (
        <span aria-hidden className="w-2.5 flex-none text-[10px] text-fg-subtle">
          {open ? '▾' : '▸'}
        </span>
      )}
      <span className={`min-w-0 truncate ${tone}`}>{node.name}</span>
      {node.scopeIds.map((scopeId) => (
        <span key={scopeId} className="flex-none text-[10px] text-cyan opacity-80">
          {scopeId}
        </span>
      ))}
      <span className="ml-auto flex-none pl-2 text-[10.5px] text-fg-subtle">
        {node.kind === 'file' ? (
          formatBytes(node.entry.sizeBytes)
        ) : node.kind === 'absent' ? (
          <span className="text-error">{inspectorCopy.checkpointAbsentTag}</span>
        ) : node.children.length === 0 ? (
          inspectorCopy.checkpointScopeEmpty
        ) : open ? (
          ''
        ) : (
          inspectorCopy.checkpointDirFiles(node.fileCount)
        )}
      </span>
    </button>
  );
}

/**
 * The chosen file's record and bytes, or what a required absence means.
 *
 * The record's metadata is rendered before the bytes and independently of them, so bytes the store
 * can no longer serve never take the record down with them.
 */
function FileDetail({
  runId,
  checkpointId,
  node,
  tree,
  base,
  compact,
}: {
  readonly runId: number;
  readonly checkpointId: string;
  readonly node: Exclude<CheckpointTreeNode, { readonly kind: 'dir' }>;
  readonly tree: CheckpointTree;
  readonly base: WorkflowCheckpointBase;
  readonly compact: boolean;
}) {
  // Coverage can overlap, so every scope that covers the path is named; none of them owns it.
  const scopes = coveringScopes(tree.scopes, node.path);
  const rows: DockRow[] = [
    { label: 'path', value: node.path },
    {
      label: 'covered by',
      value: scopes.length === 0 ? '—' : scopes.join(' · '),
      tone: scopes.length === 0 ? 'dim' : 'default',
    },
  ];

  if (node.kind === 'absent') {
    return (
      <div data-checkpoint-detail={node.path}>
        <Fields rows={rows} />
        <p className="mt-2 text-[12.5px] leading-relaxed text-fg-muted">
          {inspectorCopy.checkpointAbsentNote(
            base.kind === 'git' ? checkpointBaseLabel(base) : null,
          )}
        </p>
      </div>
    );
  }

  const { entry } = node;
  rows.push(
    { label: 'size', value: formatBytes(entry.sizeBytes) },
    { label: 'sha256', value: entry.sha256, tone: 'dim' },
    {
      label: 'mode',
      value: entry.executable
        ? inspectorCopy.checkpointExecutable
        : inspectorCopy.checkpointNotExecutable,
    },
  );
  return (
    <div data-checkpoint-detail={node.path}>
      <Fields rows={rows} />
      <div className="mt-2.5">
        <WorkflowCheckpointFileContent
          runId={runId}
          checkpointId={checkpointId}
          file={entry}
          compact={compact}
        />
      </div>
    </div>
  );
}
