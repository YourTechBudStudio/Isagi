import type {
  WorkflowCheckpointDto,
  WorkflowCheckpointFileDto,
  WorkflowCheckpointScopeDto,
  WorkflowCheckpointSummaryDto,
} from '@isagi/contracts';

import type { WorkflowRunView } from '../../../lib/workspace/workflow/run-view.js';
import { executionAddressKey, executionAncestry } from './ancestry.js';

/**
 * What the checkpoint surfaces show, derived from the records they are handed.
 *
 * A checkpoint is self-contained: the Git commit it was taken on (none for a folder project or an
 * unborn repository) plus an exact copy of each scope its plan named. Nothing is inherited from an
 * earlier checkpoint, so each one is drawn on its own.
 */

/** `git · a41c9e2`, or that there is no commit. */
export function checkpointCommitLabel(commitSha: string | null): string {
  return commitSha === null
    ? 'no commit · folder or unborn repository'
    : `git · ${commitSha.slice(0, 7)}`;
}

/**
 * The `isagi checkpoints export` line for one checkpoint. The directory stays a placeholder so a
 * pasted line cannot write anywhere nobody chose.
 */
export function checkpointExportCommand(checkpointId: number): string {
  return `isagi checkpoints export ${checkpointId} --output <directory>`;
}

/** `plan, notes` — the scope names a checkpoint captured, with a missing one marked. */
export function checkpointScopeNames(
  scopes: readonly { readonly scope: string; readonly missing: boolean }[],
): string {
  return scopes
    .map((scope) => (scope.missing ? `${scope.scope} (missing)` : scope.scope))
    .join(', ');
}

/* ── the Checkpoints tab's list ───────────────────────────────────────────────────────────── */

export interface CheckpointListGroup {
  /** The declared address, so a node id repeated in two subgraphs stays two groups. */
  readonly key: string;
  /** The node id, qualified by its subgraph path when nested. */
  readonly label: string;
  readonly items: readonly WorkflowCheckpointSummaryDto[];
}

/**
 * Every checkpoint in the run, grouped by the node that saved it, in the order each node first
 * saved one. Items keep the listing's own order, oldest first.
 */
export function groupCheckpoints(
  view: WorkflowRunView | null,
  items: readonly WorkflowCheckpointSummaryDto[],
): readonly CheckpointListGroup[] {
  const groups = new Map<string, { label: string; items: WorkflowCheckpointSummaryDto[] }>();
  for (const item of items) {
    const execution = view?.executions.get(item.executionId);
    const key =
      view != null && execution !== undefined
        ? executionAddressKey(view, execution)
        : `execution:${item.executionId}`;
    const label =
      view != null && execution !== undefined
        ? [...executionAncestry(view, execution).path, execution.nodeId].join(' ▸ ')
        : `execution ${item.executionId}`;
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else groups.set(key, { label, items: [item] });
  }
  return [...groups].map(([key, group]) => ({ key, label: group.label, items: group.items }));
}

/**
 * The checkpoint the tab should show.
 *
 * A choice that still exists is kept, whatever the dock has moved to since. With none, the dock's
 * own checkpoint execution seeds it, and otherwise the most recent checkpoint.
 */
export function resolveCheckpointSelection(
  chosen: number | null,
  items: readonly WorkflowCheckpointSummaryDto[],
  dockCheckpointId: number | null,
): number | null {
  if (chosen !== null && items.some((item) => item.checkpointId === chosen)) return chosen;
  if (dockCheckpointId !== null && items.some((item) => item.checkpointId === dockCheckpointId)) {
    return dockCheckpointId;
  }
  return items.at(-1)?.checkpointId ?? null;
}

/* ── the file tree ────────────────────────────────────────────────────────────────────────── */

export interface CheckpointTreeDir {
  readonly kind: 'dir';
  readonly path: string;
  /** One segment, or a chain of single-child directories joined by `/`. */
  readonly name: string;
  /** The scope name, on a scope's own root. */
  readonly scope: string | null;
  readonly children: readonly CheckpointTreeNode[];
  readonly fileCount: number;
}

export interface CheckpointTreeFile {
  readonly kind: 'file';
  readonly path: string;
  readonly name: string;
  readonly scope: string | null;
  readonly file: WorkflowCheckpointFileDto;
}

/** A scope whose path did not exist at capture. An export makes it absent. */
export interface CheckpointTreeMissing {
  readonly kind: 'missing';
  readonly path: string;
  readonly name: string;
  readonly scope: string;
  readonly scopeKind: WorkflowCheckpointScopeDto['kind'];
}

export type CheckpointTreeNode = CheckpointTreeDir | CheckpointTreeFile | CheckpointTreeMissing;

export interface CheckpointTree {
  /** One root per captured scope, in the plan's order. */
  readonly roots: readonly CheckpointTreeNode[];
  readonly files: number;
}

/**
 * The checkpoint as an export would write it: each scope at its path, with its files beneath.
 *
 * Scopes are drawn separately rather than merged, because each is an exact copy of what its plan
 * named and an export mirrors each on its own.
 */
export function buildCheckpointTree(checkpoint: WorkflowCheckpointDto): CheckpointTree {
  const roots: CheckpointTreeNode[] = [];
  let files = 0;
  for (const scope of checkpoint.scopes) {
    if (scope.missing) {
      roots.push({
        kind: 'missing',
        path: scope.path,
        name: scope.path,
        scope: scope.scope,
        scopeKind: scope.kind,
      });
      continue;
    }
    files += scope.files.length;
    if (scope.kind === 'file') {
      const file = scope.files[0];
      if (file)
        roots.push({ kind: 'file', path: file.path, name: file.path, scope: scope.scope, file });
      continue;
    }
    roots.push(directoryRoot(scope));
  }
  return { roots, files };
}

interface MutableDir {
  readonly path: string;
  readonly name: string;
  readonly dirs: Map<string, MutableDir>;
  readonly files: CheckpointTreeFile[];
}

function directoryRoot(scope: WorkflowCheckpointScopeDto): CheckpointTreeDir {
  const root: MutableDir = { path: scope.path, name: scope.path, dirs: new Map(), files: [] };
  for (const file of scope.files) {
    const relative = file.path.startsWith(`${scope.path}/`)
      ? file.path.slice(scope.path.length + 1)
      : file.path;
    const segments = relative.split('/');
    const name = segments.pop() ?? relative;
    let current = root;
    for (const segment of segments) {
      let next = current.dirs.get(segment);
      if (!next) {
        next = { path: `${current.path}/${segment}`, name: segment, dirs: new Map(), files: [] };
        current.dirs.set(segment, next);
      }
      current = next;
    }
    current.files.push({ kind: 'file', path: file.path, name, scope: null, file });
  }
  return finishDir(root, scope.scope);
}

function finishDir(dir: MutableDir, scope: string | null): CheckpointTreeDir {
  const dirs = [...dir.dirs.values()]
    .sort((left, right) => compareText(left.name, right.name))
    .map((child) => finishDir(child, null));
  const files = [...dir.files].sort((left, right) => compareText(left.name, right.name));

  // A directory whose only content is one directory reads as one row with it.
  if (scope === null && dirs.length === 1 && files.length === 0) {
    const only = dirs[0]!;
    return { ...only, name: `${dir.name}/${only.name}` };
  }
  const children: CheckpointTreeNode[] = [...dirs, ...files];
  const fileCount = children.reduce(
    (total, child) =>
      total + (child.kind === 'dir' ? child.fileCount : child.kind === 'file' ? 1 : 0),
    0,
  );
  return { kind: 'dir', path: dir.path, name: dir.name, scope, children, fileCount };
}

/** Every row of the tree in display order, with collapsed directories' contents left out. */
export function visibleTreeRows(
  tree: CheckpointTree,
  collapsed: ReadonlySet<string>,
): readonly { readonly node: CheckpointTreeNode; readonly depth: number }[] {
  const rows: { node: CheckpointTreeNode; depth: number }[] = [];
  const walk = (nodes: readonly CheckpointTreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.kind === 'dir' && !collapsed.has(node.path)) walk(node.children, depth + 1);
    }
  };
  walk(tree.roots, 0);
  return rows;
}

/** The file, or the missing scope, at a path. */
export function findTreeNode(tree: CheckpointTree, path: string): CheckpointTreeNode | null {
  const search = (nodes: readonly CheckpointTreeNode[]): CheckpointTreeNode | null => {
    for (const node of nodes) {
      if (node.path === path && node.kind !== 'dir') return node;
      if (node.kind === 'dir') {
        const found = search(node.children);
        if (found) return found;
      }
    }
    return null;
  };
  return search(tree.roots);
}

/** Code-unit order, so the same checkpoint always draws the same tree whatever the locale. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/* ── file content ─────────────────────────────────────────────────────────────────────────── */

/** Previews render at most this many bytes. The route has no ranges, so it bounds rendering only. */
export const previewCapBytes = 256 * 1024;

export type CheckpointPresentation = 'text' | 'json' | 'image' | 'html' | 'download';

const presentations: Readonly<Record<string, CheckpointPresentation>> = {
  md: 'text',
  markdown: 'text',
  txt: 'text',
  log: 'text',
  json: 'json',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
};

const imageTypes: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/**
 * How a saved file is shown, from its path alone.
 *
 * The content route always answers `application/octet-stream`, so the extension is the only hint
 * there is. HTML is shown as source and rendered only on request in a sandboxed frame; SVG is shown
 * only through `<img>`, where its scripts never run; everything unlisted is download-only.
 */
export function presentationForPath(path: string): CheckpointPresentation {
  return presentations[extensionOf(path)] ?? 'download';
}

/**
 * The image type to give bytes served as octet-stream. An `<img>` sniffs raster formats but will
 * not render SVG without being told what it is.
 */
export function imageMediaTypeForPath(path: string): string | null {
  return imageTypes[extensionOf(path)] ?? null;
}

export function baseName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}
