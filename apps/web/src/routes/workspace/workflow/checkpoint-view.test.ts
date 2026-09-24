import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  WorkflowCheckpointBase,
  WorkflowCheckpointInventoryEntry,
  WorkflowCheckpointSummaryDto,
  WorkflowExecutionCheckpointDto,
  WorkflowExecutionDto,
} from '@isagi/contracts';

import {
  buildCheckpointTree,
  checkpointBaseLabel,
  checkpointExportCommand,
  checkpointVisitRef,
  checkpointVisitState,
  checkpointWarningsView,
  coveringScopes,
  findTreeNode,
  groupCheckpoints,
  imageMediaTypeForPath,
  presentationForPath,
  resolveCheckpointSelection,
  shortCheckpointId,
  visibleTreeRows,
  type CheckpointTreeNode,
} from './checkpoint-view.js';
import { nested, rootFrame, runStateFixture, visit } from './test-support.js';

/**
 * The rules behind what the checkpoint surfaces claim, tested as rules.
 */

const gitBase: WorkflowCheckpointBase = {
  kind: 'git',
  repositoryId: 1,
  commitSha: 'a41c9e2f00000000000000000000000000000000',
};
const folderBase: WorkflowCheckpointBase = { kind: 'none', reason: 'folder_project' };
const unbornBase: WorkflowCheckpointBase = { kind: 'none', reason: 'unborn_repository' };

const saved = (checkpointId: string): WorkflowExecutionCheckpointDto => ({
  checkpointId,
  title: checkpointId,
  base: gitBase,
  counts: { scopes: 1, files: 1, absences: 0, warnings: 0 },
});

function checkpointVisit(
  overrides: Partial<WorkflowExecutionDto> & { readonly executionId: number },
): WorkflowExecutionDto {
  return visit({ nodeId: 'save', nodeKind: 'checkpoint', status: 'completed', ...overrides });
}

function attempt(status: 'running' | 'cancelled' | 'interrupted' | 'failed') {
  return {
    attemptId: 1,
    attemptIndex: 1,
    artifactHash: 'sha256:pin-1',
    status,
    invocationKind: 'initial',
    failure: null,
    recoveryMode: 'rerun_producer',
    producerArtifactHash: null,
  } as const;
}

/* ── visit state ─────────────────────────────────────────────────────────────────────────── */

test('a saved row wins over every status, cancelled included', () => {
  assert.equal(
    checkpointVisitState(
      checkpointVisit({
        executionId: 1,
        status: 'running',
        checkpoint: saved('wcp_a'),
        latestAttempt: attempt('cancelled'),
      }),
    ),
    'saved',
  );
});

test('only an attempt that is still running is capturing', () => {
  const running = (status: Parameters<typeof attempt>[0]) =>
    checkpointVisitState(
      checkpointVisit({
        executionId: 1,
        status: 'running',
        checkpoint: null,
        latestAttempt: attempt(status),
      }),
    );
  assert.equal(running('running'), 'capturing');
  assert.equal(running('cancelled'), 'nothing_saved');
  assert.equal(running('interrupted'), 'nothing_saved');
  assert.equal(
    checkpointVisitState(checkpointVisit({ executionId: 1, status: 'failed', checkpoint: null })),
    'nothing_saved',
  );
});

test('base labels name the short commit or why there is none', () => {
  assert.equal(checkpointBaseLabel(gitBase), 'git · a41c9e2');
  assert.equal(checkpointBaseLabel(folderBase), 'none · folder project');
  assert.equal(checkpointBaseLabel(unbornBase), 'none · unborn repository');
});

test('ids shorten for the column and the export line keeps the full id', () => {
  const id = 'wcp_7f3a91e0-1111-2222-3333-4444c21e';
  assert.equal(shortCheckpointId(id), 'wcp_7f3a…c21e');
  assert.equal(
    checkpointExportCommand(id, 42),
    `isagi checkpoints export ${id} --run 42 --output <directory>`,
  );
});

/* ── warnings ────────────────────────────────────────────────────────────────────────────── */

test('the all-clear needs read warnings, never a loading or failed read', () => {
  assert.deepEqual(checkpointWarningsView(gitBase, undefined), { kind: 'loading', standing: [] });
  assert.deepEqual(checkpointWarningsView(gitBase, null), { kind: 'failed', standing: [] });
});

test('a Git capture with only the ignored-paths note is all clear, and the note stays standing', () => {
  const view = checkpointWarningsView(gitBase, [
    { reason: 'ignored_paths_not_surveyed', count: 1, samples: [] },
  ]);
  assert.equal(view.kind, 'ready');
  assert.ok(view.kind === 'ready' && view.allClear);
  assert.deepEqual(view.standing, ['ignored_paths']);
  assert.ok(view.kind === 'ready' && view.groups.length === 0);
});

test('a folder project has no survey, so it only ever gets its standing note', () => {
  const view = checkpointWarningsView(folderBase, []);
  assert.ok(view.kind === 'ready' && !view.allClear);
  assert.deepEqual(view.standing, ['folder_project']);
});

test('an unborn repository was surveyed, so it may be all clear beside its note', () => {
  const view = checkpointWarningsView(unbornBase, []);
  assert.ok(view.kind === 'ready' && view.allClear);
  assert.deepEqual(view.standing, ['unborn_repository']);
});

test('a failed survey is a warning group, so it is never all clear', () => {
  const view = checkpointWarningsView(gitBase, [
    { reason: 'dirty_survey_unavailable', count: 1, samples: [] },
  ]);
  assert.ok(view.kind === 'ready' && !view.allClear);
  assert.deepEqual(view.kind === 'ready' && view.groups[0], {
    reason: 'dirty_survey_unavailable',
    count: 1,
    samples: [],
    more: 0,
  });
});

test('a folded dirty-path count reports what the samples leave out', () => {
  const samples = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
  const view = checkpointWarningsView(gitBase, [
    { reason: 'uncaptured_dirty_path', count: 3418, samples },
  ]);
  assert.ok(view.kind === 'ready');
  assert.equal(view.groups[0]?.more, 3413);
});

/* ── parents and the tab's list ──────────────────────────────────────────────────────────── */

const reviewFrame = nested({
  parentExecutionId: 20,
  frameId: 2,
  graphKey: 'review',
  parentFrameId: 1,
  depth: 1,
});
const parentRun = runStateFixture({
  frames: [rootFrame(), reviewFrame],
  executions: [
    checkpointVisit({ executionId: 10, visitIndex: 0, checkpoint: saved('wcp_first') }),
    checkpointVisit({ executionId: 11, visitIndex: 1, checkpoint: saved('wcp_second') }),
    visit({ executionId: 20, nodeId: 'review', nodeKind: 'subgraph' }),
    // The same node id inside a subgraph is a different node.
    checkpointVisit({ executionId: 21, frameId: 2, visitIndex: 0, checkpoint: saved('wcp_inner') }),
  ],
});

test('a parent saved by the same node reads as its visit', () => {
  const from = parentRun.executions.get(11)!;
  assert.deepEqual(checkpointVisitRef(parentRun, from, 'wcp_first'), {
    executionId: 10,
    label: 'visit 1',
  });
});

test('a parent saved under the same id in a subgraph is qualified by its path', () => {
  const from = parentRun.executions.get(11)!;
  assert.deepEqual(checkpointVisitRef(parentRun, from, 'wcp_inner'), {
    executionId: 21,
    label: 'review ▸ save visit 1',
  });
});

test('a parent no execution names resolves to nothing', () => {
  assert.equal(checkpointVisitRef(parentRun, parentRun.executions.get(11)!, 'wcp_gone'), null);
});

function summary(
  checkpointId: string,
  executionId: number,
  frameId = 1,
): WorkflowCheckpointSummaryDto {
  return {
    checkpointId,
    runId: 1,
    frameId,
    executionId,
    attemptId: 1,
    nodeId: 'save',
    title: checkpointId,
    createdAt: '2026-09-15T10:00:00.000Z',
    base: gitBase,
  };
}

test('the list groups by declared address, so a repeated node id stays two groups', () => {
  const groups = groupCheckpoints(parentRun, [
    summary('wcp_first', 10),
    summary('wcp_inner', 21, 2),
    summary('wcp_second', 11),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.items.map((item) => item.checkpointId)]),
    [
      ['save', ['wcp_first', 'wcp_second']],
      ['review ▸ save', ['wcp_inner']],
    ],
  );
});

test('a chosen checkpoint is kept; otherwise the dock seeds it, then the latest', () => {
  const items = [summary('wcp_a', 1), summary('wcp_b', 2), summary('wcp_c', 3)];
  assert.equal(resolveCheckpointSelection('wcp_a', items, 'wcp_b'), 'wcp_a');
  assert.equal(resolveCheckpointSelection(null, items, 'wcp_b'), 'wcp_b');
  assert.equal(resolveCheckpointSelection(null, items, null), 'wcp_c');
  assert.equal(resolveCheckpointSelection('wcp_gone', items, 'wcp_missing'), 'wcp_c');
  assert.equal(resolveCheckpointSelection(null, [], null), null);
});

/* ── the tree ────────────────────────────────────────────────────────────────────────────── */

const sha = 'a'.repeat(64);
const file = (path: string, fileId = `wcf_${path}`): WorkflowCheckpointInventoryEntry => ({
  kind: 'file',
  path,
  fileId,
  sha256: sha,
  sizeBytes: 10,
  executable: false,
});
const scope = (
  scopeId: string,
  path: string,
  scopeKind: 'directory' | 'file' = 'directory',
  exclusions: readonly string[] = [],
): WorkflowCheckpointInventoryEntry => ({
  kind: 'scope',
  scopeId,
  scopeKind,
  path,
  exclusions,
  capturedBy: 'wcp_a',
});

const inventory: readonly WorkflowCheckpointInventoryEntry[] = [
  scope('design', 'scratch/story/design'),
  scope('plans', 'scratch/story/planning'),
  scope('gen', 'scratch/story/planning/generated'),
  scope('decisions', 'scratch/story/decisions.md', 'file'),
  scope('empty', 'scratch/old'),
  file('scratch/story/design/architecture.md'),
  file('scratch/story/design/deep/nested/notes.md'),
  file('scratch/story/planning/phase-1.md'),
  file('scratch/story/decisions.md'),
  { kind: 'absent', path: 'scratch/story/design/obsolete.md' },
  {
    kind: 'warning',
    reason: 'symlink_skipped',
    path: 'scratch/story/design/link.md',
    scopeId: 'design',
    detail: null,
    observedBy: 'wcp_a',
  },
];

function shape(nodes: readonly CheckpointTreeNode[]): unknown[] {
  return nodes.map((node) =>
    node.kind === 'dir'
      ? {
          dir: node.name,
          scopes: node.scopeIds,
          files: node.fileCount,
          children: shape(node.children),
        }
      : { [node.kind]: node.name, scopes: node.scopeIds },
  );
}

test('the tree puts scope roots on top, labels them, and keeps warnings out', () => {
  const tree = buildCheckpointTree(inventory);
  assert.equal(tree.files, 4);
  assert.equal(tree.absences, 1);
  assert.deepEqual(shape(tree.roots), [
    {
      dir: 'scratch/old',
      scopes: ['empty'],
      files: 0,
      children: [],
    },
    {
      dir: 'scratch/story/design',
      scopes: ['design'],
      files: 2,
      children: [
        // An unlabelled chain of single directories reads as one row.
        {
          dir: 'deep/nested',
          scopes: [],
          files: 1,
          children: [{ file: 'notes.md', scopes: [] }],
        },
        { file: 'architecture.md', scopes: [] },
        { absent: 'obsolete.md', scopes: [] },
      ],
    },
    {
      dir: 'scratch/story/planning',
      scopes: ['plans'],
      files: 1,
      children: [
        // A nested scope root exists even when it holds nothing.
        { dir: 'generated', scopes: ['gen'], files: 0, children: [] },
        { file: 'phase-1.md', scopes: [] },
      ],
    },
    // A file scope outside every directory scope sits at the top under its full path.
    { file: 'scratch/story/decisions.md', scopes: ['decisions'] },
  ]);
});

test('collapsed directories hide their rows and a node can be found by path', () => {
  const tree = buildCheckpointTree(inventory);
  const all = visibleTreeRows(tree, new Set());
  const folded = visibleTreeRows(tree, new Set(['scratch/story/design']));
  assert.equal(all.length - folded.length, 4);
  assert.equal(findTreeNode(tree, 'scratch/story/design/deep/nested/notes.md')?.kind, 'file');
  assert.equal(findTreeNode(tree, 'scratch/story/design/obsolete.md')?.kind, 'absent');
  assert.equal(findTreeNode(tree, 'nowhere.md'), null);
});

test('every scope that covers a path is named, since coverage overlaps and none owns it', () => {
  const scopes = buildCheckpointTree([
    scope('app', 'src/app'),
    scope('src', 'src', 'directory', ['gen']),
    scope('readme', 'README.md', 'file'),
  ]).scopes;
  assert.deepEqual(coveringScopes(scopes, 'src/app/main.ts'), ['app', 'src']);
  assert.deepEqual(coveringScopes(scopes, 'src/lib.ts'), ['src']);
  // An exclusion narrows only its own scope.
  assert.deepEqual(coveringScopes(scopes, 'src/gen/out.ts'), []);
  assert.deepEqual(coveringScopes(scopes, 'README.md'), ['readme']);
  assert.deepEqual(coveringScopes(scopes, 'srcfoo/x.ts'), []);
});

/* ── presentation ────────────────────────────────────────────────────────────────────────── */

test('presentation comes from the extension, and HTML is download only', () => {
  const cases: readonly [string, string][] = [
    ['notes/plan.md', 'text'],
    ['a.MARKDOWN', 'text'],
    ['log/run.log', 'text'],
    ['readme.txt', 'text'],
    ['tasks.json', 'json'],
    ['shot.png', 'image'],
    ['shot.JPG', 'image'],
    ['shot.jpeg', 'image'],
    ['anim.gif', 'image'],
    ['photo.webp', 'image'],
    ['diagram.svg', 'image'],
    ['report.html', 'download'],
    ['bundle.zip', 'download'],
    ['Makefile', 'download'],
    ['.gitignore', 'download'],
  ];
  for (const [path, expected] of cases) assert.equal(presentationForPath(path), expected, path);
});

test('SVG bytes are re-typed so an <img> will render them', () => {
  assert.equal(imageMediaTypeForPath('diagram.svg'), 'image/svg+xml');
  assert.equal(imageMediaTypeForPath('shot.jpg'), 'image/jpeg');
  assert.equal(imageMediaTypeForPath('notes.md'), null);
});
