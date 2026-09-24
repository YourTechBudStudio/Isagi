import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import type {
  WorkflowCheckpointBase,
  WorkflowCheckpointDto,
  WorkflowCheckpointInventoryEntry,
  WorkflowCheckpointSummaryDto,
  WorkflowCheckpointWarningGroup,
  WorkflowExecutionCheckpointDto,
  WorkflowExecutionDto,
} from '@isagi/contracts';

import {
  runtimeIdentityQueryKey,
  workflowCheckpointInventoryQueryKey,
  workflowCheckpointListQueryKey,
  workflowCheckpointQueryKey,
} from '../../../lib/workspace/query-keys.js';
import { inspectorCopy } from './copy.js';
import { buildDockView, checkpointFilesTabKey, type DockCheckpoint, type DockRow } from './dock.js';
import {
  clockAt,
  descriptorFixture,
  graphFixture,
  rootFrame,
  runStateFixture,
  visit,
} from './test-support.js';
import { buildTopology } from './topology.js';
import { WorkflowCheckpointColumn } from './WorkflowCheckpointColumn.js';
import { WorkflowCheckpointFiles } from './WorkflowCheckpointFiles.js';
import { WorkflowCheckpointsPanel } from './WorkflowCheckpointsPanel.js';
import { WorkflowCheckpointFileContent } from './WorkflowContentViewer.js';

/**
 * What the checkpoint surfaces say, given facts.
 *
 * Markup only, over a cache seeded with what the runtime would have answered. Clicking through the
 * tree, opening the files tab from the column, content that cannot be read and the copy button live
 * in the browser suite.
 */

const runtime = 'runtime-1';
const runId = 1;
const now = clockAt(120);

function render(node: React.ReactNode, seed: (client: QueryClient) => void = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runtimeIdentityQueryKey, runtime);
  seed(client);
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
  client.clear();
  return markup;
}

/** Copy as it lands in markup. React escapes quotes, so a raw string would silently never match. */
function asRendered(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

const gitBase: WorkflowCheckpointBase = {
  kind: 'git',
  repositoryId: 1,
  commitSha: 'a41c9e2f00000000000000000000000000000000',
};

const summaryOf = (
  checkpointId: string,
  base: WorkflowCheckpointBase = gitBase,
): WorkflowExecutionCheckpointDto => ({
  checkpointId,
  title: `Phase ${checkpointId}`,
  base,
  counts: { scopes: 3, files: 22, absences: 1, warnings: 2 },
});

function detailOf(
  checkpointId: string,
  parentCheckpointId: string | null,
  warningGroups: readonly WorkflowCheckpointWarningGroup[],
  base: WorkflowCheckpointBase = gitBase,
): { readonly checkpoint: WorkflowCheckpointDto } {
  return {
    checkpoint: {
      checkpointId,
      runId,
      frameId: 1,
      executionId: 11,
      attemptId: 1,
      nodeId: 'save',
      title: `Phase ${checkpointId}`,
      createdAt: '2026-09-15T10:02:00.000Z',
      base,
      parentCheckpointId,
      artifactHash: 'sha256:pin-1',
      provenance: { repositoryRootPath: null },
      counts: { scopes: 3, files: 22, absences: 1, warnings: 2 },
      warningGroups,
      links: { inventory: '/inventory', manifest: '/manifest' },
    },
  };
}

function checkpointVisit(
  overrides: Partial<WorkflowExecutionDto> & { readonly executionId: number },
): WorkflowExecutionDto {
  return visit({ nodeId: 'save', nodeKind: 'checkpoint', status: 'completed', ...overrides });
}

const topology = buildTopology(
  descriptorFixture(
    [
      graphFixture({
        key: 'root',
        entry: 'save',
        nodes: [
          { id: 'save', kind: 'checkpoint', title: 'Save the phase' },
          { id: 'write', kind: 'operation' },
        ],
        edges: [{ id: 'save-out', from: 'save', to: ['write'] }],
        outcomes: [{ id: 'done', kind: 'success' }],
      }),
    ],
    'root',
  ),
);

const run = runStateFixture({
  frames: [rootFrame()],
  executions: [
    checkpointVisit({ executionId: 10, visitIndex: 0, checkpoint: summaryOf('wcp_first') }),
    checkpointVisit({ executionId: 11, visitIndex: 1, checkpoint: summaryOf('wcp_second') }),
    checkpointVisit({
      executionId: 12,
      visitIndex: 2,
      status: 'failed',
      checkpoint: null,
      latestAttempt: {
        attemptId: 3,
        attemptIndex: 1,
        artifactHash: 'sha256:pin-1',
        status: 'failed',
        invocationKind: 'initial',
        failure: {
          code: 'checkpoint_capture_failed',
          message: 'scope "reviews" changed identity',
          detail: { inline: { reason: 'scope_identity_changed' } },
        },
        recoveryMode: 'rerun_producer',
        producerArtifactHash: null,
      },
    }),
    visit({ executionId: 13, nodeId: 'write', nodeKind: 'operation', status: 'completed' }),
  ],
});

const fields = (rows: readonly DockRow[]) =>
  rows.filter((row): row is Exclude<DockRow, { gap: true }> => !('gap' in row));

/* ── the dock's view of a checkpoint visit ───────────────────────────────────────────────── */

test('a saved visit is titled by its checkpoint and gets a files tab', () => {
  const view = buildDockView({
    selection: { kind: 'execution', executionId: 11 },
    state: run,
    topology,
    now,
  });
  assert.ok(view !== null);
  assert.equal(view.displayName, 'Phase wcp_second');
  // The title is read from the summary, never written into the execution's own label.
  assert.equal(run.executions.get(11)?.displayName, null);
  assert.equal(view.checkpoint?.state, 'saved');
  assert.deepEqual(
    view.data.find((tab) => tab.kind === 'checkpoint_files'),
    {
      kind: 'checkpoint_files',
      key: checkpointFilesTabKey,
      name: inspectorCopy.checkpointFilesTab,
      checkpointId: 'wcp_second',
      fileCount: 22,
    },
  );
  assert.deepEqual(view.checkpoint?.parent('wcp_first'), { executionId: 10, label: 'visit 1' });
});

test('a failed visit saved nothing, keeps its failure rows and adds no reason row', () => {
  const view = buildDockView({
    selection: { kind: 'execution', executionId: 12 },
    state: run,
    topology,
    now,
  });
  assert.ok(view !== null);
  assert.equal(view.checkpoint?.state, 'nothing_saved');
  assert.equal(view.checkpoint?.summary, null);
  assert.equal(
    view.data.some((tab) => tab.kind === 'checkpoint_files'),
    false,
  );
  const labels = fields(view.recorded).map((row) => row.label);
  assert.ok(labels.includes('failed') && labels.includes('code') && labels.includes('message'));
  assert.equal(labels.includes('reason'), false);
});

test('only a checkpoint visit gets the column: not an unvisited checkpoint, not another node', () => {
  const unvisited = buildDockView({
    selection: { kind: 'element', key: [...topology.elements.keys()][0]! },
    state: runStateFixture({}),
    topology,
    now,
  });
  assert.equal(unvisited?.checkpoint, null);
  const operation = buildDockView({
    selection: { kind: 'execution', executionId: 13 },
    state: run,
    topology,
    now,
  });
  assert.equal(operation?.checkpoint, null);
});

/* ── the Checkpoint column ───────────────────────────────────────────────────────────────── */

const noParent: DockCheckpoint['parent'] = () => null;

function column(checkpoint: DockCheckpoint, seed?: (client: QueryClient) => void): string {
  return render(
    <WorkflowCheckpointColumn
      runId={runId}
      checkpoint={checkpoint}
      onOpenTab={() => undefined}
      onSelect={() => undefined}
    />,
    seed,
  );
}

test('without a saved row the column says capturing, or that nothing was saved', () => {
  const capturing = column({ state: 'capturing', summary: null, parent: noParent });
  assert.ok(capturing.includes(asRendered(inspectorCopy.checkpointCapturingNote)));
  const nothing = column({ state: 'nothing_saved', summary: null, parent: noParent });
  assert.ok(nothing.includes(asRendered(inspectorCopy.checkpointNothingSavedNote)));
  assert.doesNotMatch(nothing, /export/);
});

test('the summary shows at once, and unread warnings are never an all-clear', () => {
  const markup = column({ state: 'saved', summary: summaryOf('wcp_second'), parent: noParent });
  assert.match(markup, /git · a41c9e2/);
  assert.ok(markup.includes(asRendered(inspectorCopy.checkpointCounts(3, 22, 1))));
  assert.ok(markup.includes(`data-field-tab="${checkpointFilesTabKey}"`));
  assert.ok(markup.includes(asRendered(inspectorCopy.checkpointWarningsLoading)));
  assert.doesNotMatch(markup, /data-checkpoint-all-clear/);
});

test('warnings group by reason with samples and a total; ignored paths stay a dim note', () => {
  const samples = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
  const markup = column(
    {
      state: 'saved',
      summary: summaryOf('wcp_second'),
      parent: () => ({ executionId: 10, label: 'visit 1' }),
    },
    (client) =>
      client.setQueryData(
        workflowCheckpointQueryKey(runtime, runId, 'wcp_second'),
        detailOf('wcp_second', 'wcp_first', [
          { reason: 'uncaptured_dirty_path', count: 3418, samples },
          { reason: 'ignored_paths_not_surveyed', count: 1, samples: [] },
        ]),
      ),
  );
  assert.ok(markup.includes('data-checkpoint-warning="uncaptured_dirty_path"'));
  assert.ok(markup.includes(asRendered(inspectorCopy.checkpointWarningMore(3413))));
  assert.ok(markup.includes('3,418'));
  for (const path of samples) assert.ok(markup.includes(path));
  assert.ok(markup.includes('data-checkpoint-standing="ignored_paths"'));
  assert.doesNotMatch(markup, /data-checkpoint-warning="ignored_paths_not_surveyed"/);
  assert.doesNotMatch(markup, /data-checkpoint-all-clear/);
  // The parent is its visit, and a way to it.
  assert.ok(markup.includes('data-field-select="parent"'));
  assert.match(markup, /visit 1 · wcp_first/);
});

test('a clean Git capture is all clear; a folder project only gets its standing note', () => {
  const clean = column(
    { state: 'saved', summary: summaryOf('wcp_second'), parent: noParent },
    (client) =>
      client.setQueryData(
        workflowCheckpointQueryKey(runtime, runId, 'wcp_second'),
        detailOf('wcp_second', null, [
          { reason: 'ignored_paths_not_surveyed', count: 1, samples: [] },
        ]),
      ),
  );
  assert.match(clean, /data-checkpoint-all-clear/);
  assert.match(clean, new RegExp(`>${inspectorCopy.checkpointNoParent}<`));

  const folder: WorkflowCheckpointBase = { kind: 'none', reason: 'folder_project' };
  const folderMarkup = column(
    { state: 'saved', summary: summaryOf('wcp_folder', folder), parent: noParent },
    (client) =>
      client.setQueryData(
        workflowCheckpointQueryKey(runtime, runId, 'wcp_folder'),
        detailOf('wcp_folder', null, [], folder),
      ),
  );
  assert.match(folderMarkup, /none · folder project/);
  assert.ok(folderMarkup.includes('data-checkpoint-standing="folder_project"'));
  assert.doesNotMatch(folderMarkup, /data-checkpoint-all-clear/);
});

/* ── files ───────────────────────────────────────────────────────────────────────────────── */

const sha = 'b'.repeat(64);
const inventory: readonly WorkflowCheckpointInventoryEntry[] = [
  {
    kind: 'scope',
    scopeId: 'design',
    scopeKind: 'directory',
    path: 'scratch/design',
    exclusions: [],
    capturedBy: 'wcp_first',
  },
  {
    kind: 'file',
    path: 'scratch/design/plan.md',
    fileId: 'wcf_plan',
    sha256: sha,
    sizeBytes: 2048,
    executable: false,
  },
  { kind: 'absent', path: 'scratch/design/obsolete.md' },
  {
    kind: 'warning',
    reason: 'symlink_skipped',
    path: 'scratch/design/latest.md',
    scopeId: 'design',
    detail: null,
    observedBy: 'wcp_first',
  },
];

test('the files tab draws the final tree: scope labels, struck absences, and no warnings', () => {
  const markup = render(
    <WorkflowCheckpointFiles
      runId={runId}
      checkpointId="wcp_second"
      base={gitBase}
      counts={{ scopes: 1, files: 1, absences: 1, warnings: 1 }}
      layout="compact"
    />,
    (client) =>
      client.setQueryData(
        workflowCheckpointInventoryQueryKey(runtime, runId, 'wcp_second'),
        inventory,
      ),
  );
  assert.ok(markup.includes('data-checkpoint-row="scratch/design"'));
  assert.match(markup, />design</);
  assert.match(markup, /data-checkpoint-row="scratch\/design\/obsolete.md"[^>]*>.*line-through/s);
  assert.doesNotMatch(markup, /latest\.md/);
  assert.ok(markup.includes(asRendered('on top of git · a41c9e2')));
});

test('an unread inventory says so rather than drawing an empty tree', () => {
  const markup = render(
    <WorkflowCheckpointFiles
      runId={runId}
      checkpointId="wcp_unread"
      base={gitBase}
      counts={{ scopes: 1, files: 1, absences: 0, warnings: 0 }}
      layout="compact"
    />,
  );
  assert.ok(markup.includes(asRendered(inspectorCopy.checkpointFilesLoading)));
  assert.doesNotMatch(markup, new RegExp(asRendered(inspectorCopy.checkpointFilesEmpty)));
});

const fileEntry = (path: string, sizeBytes: number) =>
  ({
    kind: 'file',
    path,
    fileId: `wcf_${path}`,
    sha256: sha,
    sizeBytes,
    executable: false,
  }) as const;

test('a large previewable file waits for a click; HTML and unknown types are download only', () => {
  const large = render(
    <WorkflowCheckpointFileContent
      runId={runId}
      checkpointId="wcp_second"
      file={fileEntry('notes/big.md', 4 * 1024 * 1024)}
    />,
  );
  assert.ok(large.includes('data-content-load'));
  assert.ok(large.includes('data-content-download'));

  for (const path of ['report.html', 'bundle.zip']) {
    const markup = render(
      <WorkflowCheckpointFileContent
        runId={runId}
        checkpointId="wcp_second"
        file={fileEntry(path, 100)}
      />,
    );
    assert.ok(markup.includes(asRendered(inspectorCopy.checkpointDownloadOnly)), path);
    assert.doesNotMatch(markup, /<iframe|<img/);
  }
});

/* ── the Checkpoints tab ─────────────────────────────────────────────────────────────────── */

const listItem = (checkpointId: string, executionId: number): WorkflowCheckpointSummaryDto => ({
  checkpointId,
  runId,
  frameId: 1,
  executionId,
  attemptId: 1,
  nodeId: 'save',
  title: `Phase ${checkpointId}`,
  createdAt: '2026-09-15T10:02:00.000Z',
  base: gitBase,
});

test('the tab lists every checkpoint by node and shows the chosen one with its export line', () => {
  const markup = render(
    <WorkflowCheckpointsPanel
      runId={runId}
      state={run}
      chosenId="wcp_first"
      dockCheckpointId="wcp_second"
      onSeed={() => undefined}
      onSelect={() => undefined}
    />,
    (client) => {
      client.setQueryData(workflowCheckpointListQueryKey(runtime, runId, 2), [
        listItem('wcp_first', 10),
        listItem('wcp_second', 11),
      ]);
      client.setQueryData(
        workflowCheckpointInventoryQueryKey(runtime, runId, 'wcp_first'),
        inventory,
      );
    },
  );
  assert.match(markup, /save<\/span> · 2 visits/);
  // The explicit choice wins over the dock's visit.
  assert.match(
    markup,
    /data-checkpoint-item="wcp_first"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-checkpoint-item="wcp_first"/,
  );
  assert.ok(
    markup.includes('isagi checkpoints export wcp_first --run 1 --output &lt;directory&gt;'),
  );
  assert.ok(markup.includes(asRendered(inspectorCopy.checkpointExportNote)));
  // No counts or warning badges on the list; the counts belong to the chosen checkpoint's tree.
  const list = markup.slice(0, markup.indexOf('data-checkpoint-files'));
  assert.doesNotMatch(list, /files|absent|warning/);
});
