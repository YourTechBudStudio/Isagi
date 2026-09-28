import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  runtimeIdentityQueryKey,
  workflowCheckpointQueryKey,
} from '../../../lib/workspace/query-keys.js';
import { workflowCheckpointFixture } from '../../../lib/workspace/workflow/test-support.js';
import { inspectorCopy } from './copy.js';
import { WorkflowCheckpointColumn } from './WorkflowCheckpointColumn.js';
import { WorkflowCheckpointFiles } from './WorkflowCheckpointFiles.js';

/** The dock's checkpoint column and the files tree, rendered from a seeded checkpoint read. */

const identity = 'http://runtime.test';

function render(node: React.ReactNode, seed: (client: QueryClient) => void = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runtimeIdentityQueryKey, identity);
  seed(client);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
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
