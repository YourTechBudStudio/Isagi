import assert from 'node:assert/strict';
import test from 'node:test';

import {
  workflowCheckpointFixture,
  workflowCheckpointSummaryFixture,
} from '../../../lib/workspace/workflow/test-support.js';
import {
  buildCheckpointTree,
  checkpointCommitLabel,
  checkpointExportCommand,
  findTreeNode,
  groupCheckpoints,
  presentationForPath,
  resolveCheckpointSelection,
  visibleTreeRows,
} from './checkpoint-view.js';
import { nested, rootInvocation, runViewFixture, visit } from './test-support.js';

const file = (path: string, sizeBytes = 3) => ({
  path,
  sha256: 'c'.repeat(64),
  sizeBytes,
  executable: false,
});

test('each scope is its own root: a file, a directory tree, and a missing path', () => {
  const tree = buildCheckpointTree(
    workflowCheckpointFixture({
      scopes: [
        {
          scope: 'plan',
          kind: 'file',
          path: 'PLAN.md',
          exclude: [],
          missing: false,
          files: [file('PLAN.md')],
        },
        {
          scope: 'notes',
          kind: 'directory',
          path: 'notes',
          exclude: ['tmp'],
          missing: false,
          files: [file('notes/a.md'), file('notes/deep/nested/b.md')],
        },
        { scope: 'draft', kind: 'file', path: 'DRAFT.md', exclude: [], missing: true, files: [] },
      ],
    }),
  );
  assert.equal(tree.files, 3);
  assert.deepEqual(
    tree.roots.map((root) => [root.kind, root.path, root.scope]),
    [
      ['file', 'PLAN.md', 'plan'],
      ['dir', 'notes', 'notes'],
      ['missing', 'DRAFT.md', 'draft'],
    ],
  );
  const rows = visibleTreeRows(tree, new Set());
  // A chain of single-child directories reads as one row.
  assert.ok(rows.some((row) => row.node.kind === 'dir' && row.node.name === 'deep/nested'));
  assert.equal(findTreeNode(tree, 'notes/a.md')?.kind, 'file');
  assert.equal(findTreeNode(tree, 'DRAFT.md')?.kind, 'missing');
  // Collapsing a scope hides what is under it.
  assert.equal(visibleTreeRows(tree, new Set(['notes'])).length, 3);
});

test('the commit label and export line say exactly what an export needs', () => {
  assert.equal(checkpointCommitLabel('abcdef0123456789abcdef0123456789abcdef01'), 'git · abcdef0');
  assert.match(checkpointCommitLabel(null), /no commit/);
  assert.equal(checkpointExportCommand(12), 'isagi checkpoints export 12 --output <directory>');
});

test('checkpoints group by the declared address that saved them, including subgraph nesting', () => {
  const view = runViewFixture({
    invocations: [
      rootInvocation(),
      nested({ parentExecutionId: 1, invocationId: 2, graphKey: 'phase', depth: 1 }),
    ],
    executions: [
      visit({ executionId: 1, nodeId: 'phase', nodeKind: 'subgraph', childInvocationId: 2 }),
      visit({
        executionId: 2,
        invocationId: 2,
        nodeId: 'save',
        nodeKind: 'checkpoint',
        checkpointId: 1,
      }),
      visit({
        executionId: 3,
        invocationId: 2,
        nodeId: 'save',
        nodeKind: 'checkpoint',
        checkpointId: 2,
      }),
    ],
  });
  const groups = groupCheckpoints(view, [
    workflowCheckpointSummaryFixture({ checkpointId: 1, executionId: 2 }),
    workflowCheckpointSummaryFixture({ checkpointId: 2, executionId: 3 }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.label, 'phase ▸ save');
  assert.equal(groups[0]!.items.length, 2);
});

test('a kept choice wins, then the dock, then the latest', () => {
  const items = [1, 2, 3].map((checkpointId) => workflowCheckpointSummaryFixture({ checkpointId }));
  assert.equal(resolveCheckpointSelection(1, items, 2), 1);
  assert.equal(resolveCheckpointSelection(9, items, 2), 2);
  assert.equal(resolveCheckpointSelection(null, items, null), 3);
});

test('html is previewed (in a sandbox), unknown types are download-only', () => {
  assert.equal(presentationForPath('report.html'), 'html');
  assert.equal(presentationForPath('notes/a.md'), 'text');
  assert.equal(presentationForPath('bin/tool'), 'download');
});
