import { useMemo, useState } from 'react';

import type { WorkflowCheckpointDto } from '@isagi/contracts';

import { useWorkflowCheckpoint } from '../../../lib/workspace/workflow/queries.js';
import {
  buildCheckpointTree,
  checkpointCommitLabel,
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
 * A checkpoint's files: what an export of it would write.
 *
 * The same tree in both places it appears. In the dock's `files` tab it is compact, with the chosen
 * file shown beneath it; in the Checkpoints tab it is the middle pane and the chosen file gets the
 * pane beside it, with the export line under that. Callers key it on the checkpoint: a path chosen
 * in one tree says nothing about another.
 */
export function WorkflowCheckpointFiles({
  checkpointId,
  layout,
  aside = null,
}: {
  readonly checkpointId: number;
  readonly layout: 'compact' | 'panes';
  /** Rendered under the chosen file's details in the `panes` layout: the export line. */
  readonly aside?: React.ReactNode;
}) {
  const detail = useWorkflowCheckpoint(checkpointId);
  const checkpoint = detail.data ?? null;
  const tree = useMemo(
    () => (checkpoint === null ? null : buildCheckpointTree(checkpoint)),
    [checkpoint],
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const selected = tree === null || selectedPath === null ? null : findTreeNode(tree, selectedPath);
  const heading =
    checkpoint === null
      ? ''
      : inspectorCopy.checkpointFilesHeading(
          inspectorCopy.checkpointCounts(checkpoint.scopes.length, tree?.files ?? 0),
          checkpointCommitLabel(checkpoint.commitSha),
        );

  const treePane =
    detail.error !== null ? (
      <div className="px-3.5 py-2">
        <p className="text-[12.5px] text-fg-muted">{inspectorCopy.checkpointFilesFailed}</p>
        <button
          type="button"
          onClick={() => void detail.refetch()}
          className="mt-1.5 rounded-md bg-white/6 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:bg-white/10"
        >
          {inspectorCopy.checkpointFilesRetry}
        </button>
      </div>
    ) : tree === null ? (
      <p className="px-3.5 py-2 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.checkpointFilesLoading}
      </p>
    ) : tree.roots.length === 0 ? (
      <p className="px-3.5 py-2 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.checkpointFilesEmpty}
      </p>
    ) : (
      <CheckpointFileTree
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

  const fileDetail =
    selected === null || selected.kind === 'dir' || checkpoint === null ? null : (
      <FileDetail checkpoint={checkpoint} node={selected} compact={layout === 'compact'} />
    );

  if (layout === 'compact') {
    return (
      <div data-checkpoint-files={checkpointId}>
        <p className="mb-1 font-mono text-[11px] text-fg-subtle">{heading}</p>
        <div className="max-h-64 overflow-auto rounded-lg border border-line/22 bg-canvas/45 py-1">
          {treePane}
        </div>
        {fileDetail !== null && <div className="mt-2.5">{fileDetail}</div>}
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
        {fileDetail ?? (
          <p className="font-mono text-[11.5px] text-fg-subtle">
            {inspectorCopy.checkpointSelectHint}
          </p>
        )}
        {aside}
      </div>
    </div>
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
      {rows.map(({ node, depth }, index) => (
        <TreeRow
          key={`${index}:${node.kind}:${node.path}`}
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
      : node.kind === 'missing'
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
      {node.scope !== null && (
        <span className="flex-none text-[10px] text-cyan opacity-80">{node.scope}</span>
      )}
      <span className="ml-auto flex-none pl-2 text-[10.5px] text-fg-subtle">
        {node.kind === 'file' ? (
          formatBytes(node.file.sizeBytes)
        ) : node.kind === 'missing' ? (
          <span className="text-error">{inspectorCopy.checkpointMissingTag}</span>
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
 * The chosen file's record and bytes, or what a missing scope means.
 *
 * The record's metadata is rendered before the bytes and independently of them, so bytes the store
 * can no longer serve never take the record down with them.
 */
function FileDetail({
  checkpoint,
  node,
  compact,
}: {
  readonly checkpoint: WorkflowCheckpointDto;
  readonly node: Exclude<CheckpointTreeNode, { readonly kind: 'dir' }>;
  readonly compact: boolean;
}) {
  if (node.kind === 'missing') {
    return (
      <div data-checkpoint-detail={node.path}>
        <Fields
          rows={[
            { label: 'path', value: node.path },
            { label: 'scope', value: node.scope },
          ]}
        />
        <p className="mt-2 text-[12.5px] leading-relaxed text-fg-muted">
          {inspectorCopy.checkpointMissingNote}
        </p>
      </div>
    );
  }

  const { file } = node;
  const rows: DockRow[] = [
    { label: 'path', value: file.path },
    { label: 'size', value: formatBytes(file.sizeBytes) },
    { label: 'sha256', value: file.sha256, tone: 'dim' },
    {
      label: 'mode',
      value: file.executable
        ? inspectorCopy.checkpointExecutable
        : inspectorCopy.checkpointNotExecutable,
    },
  ];
  return (
    <div data-checkpoint-detail={file.path}>
      <Fields rows={rows} />
      <div className="mt-2.5">
        <WorkflowCheckpointFileContent
          checkpointId={checkpoint.checkpointId}
          file={file}
          compact={compact}
        />
      </div>
    </div>
  );
}
