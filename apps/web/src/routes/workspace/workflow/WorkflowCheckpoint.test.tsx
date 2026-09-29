import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  runtimeIdentityQueryKey,
  workflowCheckpointListQueryKey,
  workflowCheckpointQueryKey,
} from '../../../lib/workspace/query-keys.js';
import {
  workflowCheckpointFixture,
  workflowCheckpointSummaryFixture,
} from '../../../lib/workspace/workflow/test-support.js';
import { inspectorCopy } from './copy.js';
import { WorkflowCheckpointColumn } from './WorkflowCheckpointColumn.js';
import { WorkflowCheckpointFiles } from './WorkflowCheckpointFiles.js';
import { WorkflowCheckpointsPanel } from './WorkflowCheckpointsPanel.js';

/** The dock's checkpoint column and the files tree, rendered from a seeded checkpoint read. */

const identity = 'http://runtime.test';

function render(node: React.ReactNode, seed: (client: QueryClient) => void = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runtimeIdentityQueryKey, identity);
  seed(client);
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
  // Queries with their own `gcTime` arm a timer that would hold the test process open.
  client.clear();
  return markup;
}

const checkpoint = workflowCheckpointFixture({
  checkpointId: 7,
  scopes: [
    {
      scope: 'plan',
      kind: 'file',
      path: 'PLAN.md',
      exclude: [],
      missing: false,
      files: [{ path: 'PLAN.md', sha256: 'a'.repeat(64), sizeBytes: 12, executable: false }],
    },
    { scope: 'notes', kind: 'directory', path: 'notes', exclude: [], missing: true, files: [] },
  ],
});
const seed = (client: QueryClient) =>
  client.setQueryData(workflowCheckpointQueryKey(identity, 7), checkpoint);

test('without a saved checkpoint the column says capturing, or that nothing was saved', () => {
  assert.match(
    render(
      <WorkflowCheckpointColumn
        checkpoint={{ state: 'capturing', checkpointId: null }}
        onOpenTab={() => {}}
      />,
    ),
    new RegExp(inspectorCopy.checkpointCapturingNote),
  );
  assert.match(
    render(
      <WorkflowCheckpointColumn
        checkpoint={{ state: 'nothing_saved', checkpointId: null }}
        onOpenTab={() => {}}
      />,
    ),
    new RegExp(inspectorCopy.checkpointNothingSavedNote),
  );
});

test('a saved checkpoint names its commit and scopes, marking a missing one', () => {
  const markup = render(
    <WorkflowCheckpointColumn
      checkpoint={{ state: 'saved', checkpointId: 7 }}
      onOpenTab={() => {}}
    />,
    seed,
  );
  assert.match(markup, /git · aaaaaaa/);
  assert.match(markup, /plan, notes \(missing\)/);
  assert.match(markup, /2 scopes · 1 file/);
});

test('the files tab draws one root per scope, with a missing scope struck through', () => {
  const markup = render(<WorkflowCheckpointFiles checkpointId={7} layout="compact" />, seed);
  assert.match(markup, /data-checkpoint-row="PLAN.md" data-checkpoint-row-kind="file"/);
  assert.match(markup, /data-checkpoint-row="notes" data-checkpoint-row-kind="missing"/);
  assert.match(markup, new RegExp(`>${inspectorCopy.checkpointMissingTag}<`));
});

test('the column shows the checkpoint title and its label, or a dim dash without one', () => {
  const column = (label: string | null) =>
    render(
      <WorkflowCheckpointColumn
        checkpoint={{ state: 'saved', checkpointId: 7 }}
        onOpenTab={() => {}}
      />,
      (client) =>
        client.setQueryData(workflowCheckpointQueryKey(identity, 7), {
          ...checkpoint,
          title: 'Save completed phase',
          label,
        }),
    );

  const labelled = column('Phase 2');
  assert.match(labelled, />title<\/dt><dd[^>]*>Save completed phase<\/dd>/);
  assert.match(labelled, />label<\/dt><dd[^>]*>Phase 2<\/dd>/);
  assert.match(column(null), />label<\/dt><dd[^>]*>—<\/dd>/);
});

test('the Checkpoints tab lists each checkpoint as its title with the label after it', () => {
  const items = [
    workflowCheckpointSummaryFixture({
      checkpointId: 1,
      executionId: 11,
      title: 'Save completed phase',
      label: 'Phase 1',
    }),
    workflowCheckpointSummaryFixture({
      checkpointId: 2,
      executionId: 12,
      title: 'Save completed phase',
      label: null,
    }),
  ];
  const markup = render(
    <WorkflowCheckpointsPanel
      runId={1}
      view={null}
      chosenId={1}
      dockCheckpointId={null}
      onSeed={() => {}}
      onSelect={() => {}}
    />,
    (client) => client.setQueryData(workflowCheckpointListQueryKey(identity, 1), items),
  );
  const [, first = '', second = ''] = markup.split('data-checkpoint-item=');

  assert.match(first, />Save completed phase<\/span><span[^>]*>Phase 1<\/span>/);
  // No label, no suffix: the title closes its line.
  assert.match(second, />Save completed phase<\/span><\/span>/);
});
