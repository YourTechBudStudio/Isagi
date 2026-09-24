import type {
  WorkflowCheckpointBase,
  WorkflowCheckpointInventoryEntry,
  WorkflowCheckpointSummaryDto,
  WorkflowCheckpointWarningGroup,
  WorkflowExecutionDto,
} from '@isagi/contracts';

import type { WorkflowRunState } from '../../../lib/workspace/workflow/model.js';
import { executionAddressKey, executionAncestry } from './ancestry.js';

/**
 * What the checkpoint surfaces show, derived from the records they are handed.
 *
 * Pure, so the rules that decide what a person is told about a saved checkpoint are tested as rules:
 * when "everything was captured" is actually true, which visit a parent checkpoint belongs to, what
 * the final file tree looks like, and which bytes may be previewed at all.
 */

/* ── the visit's own capture ──────────────────────────────────────────────────────────────── */

export type ScopeEntry = Extract<WorkflowCheckpointInventoryEntry, { readonly kind: 'scope' }>;
export type FileEntry = Extract<WorkflowCheckpointInventoryEntry, { readonly kind: 'file' }>;
export type AbsentEntry = Extract<WorkflowCheckpointInventoryEntry, { readonly kind: 'absent' }>;

/**
 * Where a checkpoint visit stands, from its execution alone.
 *
 * A saved row always wins, cancelled or not. Without one, only an attempt that is still running is
 * capturing: a Cancel ends the attempt while the execution can still read `running`, and an
 * interrupted attempt is waiting on recovery, not on the filesystem. Everything else saved nothing.
 */
export type CheckpointVisitState = 'saved' | 'capturing' | 'nothing_saved';

export function checkpointVisitState(execution: WorkflowExecutionDto): CheckpointVisitState {
  if (execution.checkpoint !== null) return 'saved';
  if (execution.status === 'running') {
    const attempt = execution.latestAttempt;
    if (attempt === null || attempt.status === 'running') return 'capturing';
  }
  return 'nothing_saved';
}

/** `git · a41c9e2`, or the reason there is no base at all. */
export function checkpointBaseLabel(base: WorkflowCheckpointBase): string {
  if (base.kind === 'git') return `git · ${base.commitSha.slice(0, 7)}`;
  return base.reason === 'folder_project' ? 'none · folder project' : 'none · unborn repository';
}

/** `wcp_7f3a…c21e`. The full id stays available wherever it can be copied. */
export function shortCheckpointId(checkpointId: string): string {
  const prefix = 'wcp_';
  const body = checkpointId.startsWith(prefix) ? checkpointId.slice(prefix.length) : checkpointId;
  if (body.length <= 10) return checkpointId;
  return `${checkpointId.startsWith(prefix) ? prefix : ''}${body.slice(0, 4)}…${body.slice(-4)}`;
}

/**
 * The export command #47 will run. Shown ahead of it, knowingly; the directory stays a placeholder
 * so a pasted line cannot write anywhere nobody chose.
 */
export function checkpointExportCommand(checkpointId: string, runId: number): string {
  return `isagi checkpoints export ${checkpointId} --run ${runId} --output <directory>`;
}

/* ── warnings ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Standing notes describe every checkpoint of a kind rather than something this capture ran into,
 * so they are dim and never amber.
 */
export type CheckpointStandingNote = 'ignored_paths' | 'folder_project' | 'unborn_repository';

export interface CheckpointWarningDisplay {
  /** Never `warnings_truncated`: the sentinel's count is already folded into the dirty-path group. */
  readonly reason: Exclude<WorkflowCheckpointWarningGroup['reason'], 'ignored_paths_not_surveyed'>;
  readonly count: number;
  readonly samples: readonly string[];
  /** Paths counted but not sampled. Zero for reasons that carry no path. */
  readonly more: number;
}

export type CheckpointWarningsView =
  | { readonly kind: 'loading'; readonly standing: readonly CheckpointStandingNote[] }
  | { readonly kind: 'failed'; readonly standing: readonly CheckpointStandingNote[] }
  | {
      readonly kind: 'ready';
      readonly groups: readonly CheckpointWarningDisplay[];
      readonly standing: readonly CheckpointStandingNote[];
      /**
       * True only when a change survey ran and found nothing left out. A folder project has no
       * survey, so it never earns this line; neither does a capture whose warnings are unread.
       */
      readonly allClear: boolean;
    };

/**
 * The bottom half of the column, from the base (known at once) and the detail's warning groups
 * (known once read).
 *
 * `undefined` groups mean the detail is still being read; `null` means it could not be. Neither may
 * fall through to the all-clear line, which is a claim that needs the warnings to back it.
 */
export function checkpointWarningsView(
  base: WorkflowCheckpointBase,
  groups: readonly WorkflowCheckpointWarningGroup[] | null | undefined,
): CheckpointWarningsView {
  const baseNotes: CheckpointStandingNote[] =
    base.kind === 'none'
      ? [base.reason === 'folder_project' ? 'folder_project' : 'unborn_repository']
      : [];
  if (groups === undefined) return { kind: 'loading', standing: baseNotes };
  if (groups === null) return { kind: 'failed', standing: baseNotes };

  const shown: CheckpointWarningDisplay[] = [];
  let ignored = false;
  for (const group of groups) {
    if (group.reason === 'ignored_paths_not_surveyed') {
      ignored = true;
      continue;
    }
    shown.push({
      reason: group.reason,
      count: group.count,
      samples: group.samples,
      more: group.samples.length === 0 ? 0 : Math.max(0, group.count - group.samples.length),
    });
  }
  const surveyed = !(base.kind === 'none' && base.reason === 'folder_project');
  return {
    kind: 'ready',
    groups: shown,
    standing: ignored ? ['ignored_paths', ...baseNotes] : baseNotes,
    allClear: surveyed && shown.length === 0,
  };
}

/* ── which visit saved a checkpoint ───────────────────────────────────────────────────────── */

export interface CheckpointVisitRef {
  readonly executionId: number;
  /** `visit 2`, or `review ▸ save visit 1` for a different declared address. */
  readonly label: string;
}

/**
 * The visit that saved `checkpointId`, labelled relative to the visit being looked at.
 *
 * "The same node" means the same declared address, subgraph ancestry included: a node id repeated
 * in two subgraphs is two nodes. Null when no execution in run state names the checkpoint, and the
 * caller falls back to the id alone.
 */
export function checkpointVisitRef(
  state: WorkflowRunState,
  from: WorkflowExecutionDto,
  checkpointId: string,
): CheckpointVisitRef | null {
  let owner: WorkflowExecutionDto | null = null;
  for (const execution of state.executions.values()) {
    if (execution.checkpoint?.checkpointId === checkpointId) {
      owner = execution;
      break;
    }
  }
  if (owner === null) return null;
  const visitLabel = `visit ${owner.visitIndex + 1}`;
  if (executionAddressKey(state, owner) === executionAddressKey(state, from)) {
    return { executionId: owner.executionId, label: visitLabel };
  }
  const path = [...executionAncestry(state, owner).path, owner.nodeId].join(' ▸ ');
  return { executionId: owner.executionId, label: `${path} ${visitLabel}` };
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
  state: WorkflowRunState | null,
  items: readonly WorkflowCheckpointSummaryDto[],
): readonly CheckpointListGroup[] {
  const groups = new Map<string, { label: string; items: WorkflowCheckpointSummaryDto[] }>();
  for (const item of items) {
    const execution = state?.executions.get(item.executionId);
    const key =
      state !== null && execution !== undefined
        ? executionAddressKey(state, execution)
        : `frame:${item.frameId}/${item.nodeId}`;
    const path =
      state !== null && execution !== undefined ? executionAncestry(state, execution).path : [];
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else groups.set(key, { label: [...path, item.nodeId].join(' ▸ '), items: [item] });
  }
  return [...groups].map(([key, group]) => ({ key, label: group.label, items: group.items }));
}

/**
 * The checkpoint the tab should show.
 *
 * A choice that still exists is kept, whatever the dock has moved to since. With none, the dock's
 * own checkpoint visit seeds it, and otherwise the most recent checkpoint.
 */
export function resolveCheckpointSelection(
  chosen: string | null,
  items: readonly WorkflowCheckpointSummaryDto[],
  dockCheckpointId: string | null,
): string | null {
  if (chosen !== null && items.some((item) => item.checkpointId === chosen)) return chosen;
  if (dockCheckpointId !== null && items.some((item) => item.checkpointId === dockCheckpointId)) {
    return dockCheckpointId;
  }
  return items.at(-1)?.checkpointId ?? null;
}

/* ── the final file tree ──────────────────────────────────────────────────────────────────── */

export interface CheckpointTreeDir {
  readonly kind: 'dir';
  readonly path: string;
  /** One segment, or a chain of unlabelled single-child directories joined by `/`. */
  readonly name: string;
  readonly scopeIds: readonly string[];
  readonly children: readonly CheckpointTreeNode[];
  readonly fileCount: number;
}

export interface CheckpointTreeFile {
  readonly kind: 'file';
  readonly path: string;
  readonly name: string;
  readonly scopeIds: readonly string[];
  readonly entry: FileEntry;
}

export interface CheckpointTreeAbsent {
  readonly kind: 'absent';
  readonly path: string;
  readonly name: string;
  readonly scopeIds: readonly string[];
}

export type CheckpointTreeNode = CheckpointTreeDir | CheckpointTreeFile | CheckpointTreeAbsent;

export interface CheckpointTree {
  readonly roots: readonly CheckpointTreeNode[];
  readonly scopes: readonly ScopeEntry[];
  readonly files: number;
  readonly absences: number;
}

/**
 * The final state an export would produce, as a tree.
 *
 * Scope roots sit at the top under their full paths, because a scope is what an author named and
 * the path is how they named it. Inside one, paths nest; a chain of unlabelled directories with one
 * child each reads as one row rather than as a staircase. Warnings are not files and are not here.
 * Nothing is layered: this is the resolved inventory, whichever checkpoint saved each file.
 */
export function buildCheckpointTree(
  entries: readonly WorkflowCheckpointInventoryEntry[],
): CheckpointTree {
  const scopes = entries.filter((entry): entry is ScopeEntry => entry.kind === 'scope');
  const leaves = entries.filter(
    (entry): entry is FileEntry | AbsentEntry => entry.kind === 'file' || entry.kind === 'absent',
  );

  const dirLabels = new Map<string, string[]>();
  const fileLabels = new Map<string, string[]>();
  for (const scope of scopes) {
    const target = scope.scopeKind === 'directory' ? dirLabels : fileLabels;
    const labels = target.get(scope.path) ?? [];
    if (!labels.includes(scope.scopeId)) labels.push(scope.scopeId);
    target.set(scope.path, labels);
  }

  // The outermost directory roots. A scope nested inside another's directory is drawn inside it.
  const dirPaths = [...dirLabels.keys()].sort(compareText);
  const topRoots = dirPaths.filter(
    (path) => !dirPaths.some((other) => other !== path && isBeneath(path, other)),
  );

  const builders = new Map<string, MutableDir>();
  for (const root of topRoots) builders.set(root, newDir(root, root));
  const loose: (CheckpointTreeFile | CheckpointTreeAbsent)[] = [];

  const rootOf = (path: string): string | null =>
    topRoots.find((root) => isBeneath(path, root)) ?? null;

  // Nested scope roots exist in the tree even when they hold nothing: an empty scope is a fact.
  for (const path of dirPaths) {
    const root = rootOf(path);
    if (root !== null) ensureDir(builders.get(root)!, root, path);
  }

  for (const entry of leaves) {
    const root = rootOf(entry.path);
    const leaf = leafNode(entry, fileLabels.get(entry.path) ?? []);
    if (root === null) {
      loose.push({ ...leaf, name: entry.path });
      continue;
    }
    const parent = ensureDir(builders.get(root)!, root, parentOf(entry.path));
    parent.leaves.push(leaf);
  }

  const roots: CheckpointTreeNode[] = [
    ...topRoots.map((root) => finishDir(builders.get(root)!, dirLabels, true)),
    ...loose.sort((left, right) => compareText(left.path, right.path)),
  ];
  return {
    roots,
    scopes,
    files: leaves.filter((entry) => entry.kind === 'file').length,
    absences: leaves.filter((entry) => entry.kind === 'absent').length,
  };
}

/**
 * Every scope whose coverage contains a path: its root covers the path and none of its exclusions
 * do. Coverage may overlap across layers and no region owns a file, so this is a set, never "the"
 * scope. Ids appear once, in inventory order.
 */
export function coveringScopes(scopes: readonly ScopeEntry[], path: string): readonly string[] {
  const ids: string[] = [];
  for (const scope of scopes) {
    const covers =
      scope.scopeKind === 'file'
        ? scope.path === path
        : isBeneath(path, scope.path) &&
          !scope.exclusions.some((exclusion) =>
            isBeneath(path.slice(scope.path.length + 1), exclusion),
          );
    if (covers && !ids.includes(scope.scopeId)) ids.push(scope.scopeId);
  }
  return ids;
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

export function findTreeNode(tree: CheckpointTree, path: string): CheckpointTreeNode | null {
  const search = (nodes: readonly CheckpointTreeNode[]): CheckpointTreeNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.kind === 'dir' && isBeneath(path, node.path)) {
        const found = search(node.children);
        if (found) return found;
      }
    }
    return null;
  };
  return search(tree.roots);
}

interface MutableDir {
  readonly path: string;
  readonly name: string;
  readonly dirs: Map<string, MutableDir>;
  readonly leaves: (CheckpointTreeFile | CheckpointTreeAbsent)[];
}

function newDir(path: string, name: string): MutableDir {
  return { path, name, dirs: new Map(), leaves: [] };
}

function ensureDir(root: MutableDir, rootPath: string, path: string): MutableDir {
  if (path === rootPath) return root;
  let current = root;
  for (const segment of path.slice(rootPath.length + 1).split('/')) {
    let next = current.dirs.get(segment);
    if (!next) {
      next = newDir(`${current.path}/${segment}`, segment);
      current.dirs.set(segment, next);
    }
    current = next;
  }
  return current;
}

function finishDir(
  dir: MutableDir,
  labels: ReadonlyMap<string, readonly string[]>,
  isRoot: boolean,
): CheckpointTreeDir {
  const scopeIds = labels.get(dir.path) ?? [];
  const dirs = [...dir.dirs.values()]
    .sort((left, right) => compareText(left.name, right.name))
    .map((child) => finishDir(child, labels, false));
  const leaves = [...dir.leaves].sort((left, right) => compareText(left.name, right.name));

  // An unlabelled directory whose only content is one directory reads as one row with it.
  if (!isRoot && scopeIds.length === 0 && dirs.length === 1 && leaves.length === 0) {
    const only = dirs[0]!;
    return { ...only, name: `${dir.name}/${only.name}` };
  }
  const children: CheckpointTreeNode[] = [...dirs, ...leaves];
  const fileCount = children.reduce(
    (total, child) =>
      total + (child.kind === 'dir' ? child.fileCount : child.kind === 'file' ? 1 : 0),
    0,
  );
  return { kind: 'dir', path: dir.path, name: dir.name, scopeIds, children, fileCount };
}

function leafNode(
  entry: FileEntry | AbsentEntry,
  scopeIds: readonly string[],
): CheckpointTreeFile | CheckpointTreeAbsent {
  const name = entry.path.split('/').at(-1) ?? entry.path;
  return entry.kind === 'file'
    ? { kind: 'file', path: entry.path, name, scopeIds, entry }
    : { kind: 'absent', path: entry.path, name, scopeIds };
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

/** `path` is `ancestor` or lies beneath it. */
function isBeneath(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Code-unit order, so the same inventory always draws the same tree whatever the locale. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/* ── file content ─────────────────────────────────────────────────────────────────────────── */

export type CheckpointPresentation = 'text' | 'json' | 'image' | 'download';

const presentations: Readonly<Record<string, CheckpointPresentation>> = {
  md: 'text',
  markdown: 'text',
  txt: 'text',
  log: 'text',
  json: 'json',
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
 * there is. HTML and everything unlisted are download-only: a saved page is not something to open
 * inside the inspector, and SVG is shown only through `<img>`, where its scripts never run.
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
