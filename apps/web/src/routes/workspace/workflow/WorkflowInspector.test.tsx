import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  runtimeIdentityQueryKey,
  workflowEventsQueryKey,
  workflowRunQueryKey,
} from '../../../lib/workspace/query-keys.js';
import {
  workflowRunDetailFixture,
  workflowSummaryFixture,
} from '../../../lib/workspace/workflow/test-support.js';
import { inspectorCopy } from './copy.js';
import { WorkflowInspector } from './WorkflowInspector.js';

/**
 * A failed read is said out loud. A run that could not be read, or one whose event log could not be
 * read, must not be drawn as though it were a complete (or empty) record.
 */

const identity = 'http://runtime.test';

function failed(client: QueryClient, queryKey: readonly unknown[]) {
  client
    .getQueryCache()
    .build(client, { queryKey })
    .setState({ status: 'error', error: new Error('unreachable'), fetchStatus: 'idle' });
}

function render(seed: (client: QueryClient) => void): string {
  // A static render has no mount to refetch on, so an errored read is shown as the error it is.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  client.setQueryData(runtimeIdentityQueryKey, identity);
  seed(client);
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <WorkflowInspector summary={workflowSummaryFixture()} bottomInset={0} onClose={() => {}} />
    </QueryClientProvider>,
  );
  // Drops the cache's garbage-collection timers, which would otherwise keep the process alive.
  client.clear();
  return markup;
}

const plain = (markup: string) => markup.replaceAll('&#x27;', "'");

test('a run that could not be read says so, with a retry, instead of drawing an empty run', () => {
  const markup = plain(render((client) => failed(client, workflowRunQueryKey(identity, 1))));
  assert.match(markup, /data-run-read="failed"/);
  assert.ok(markup.includes(inspectorCopy.runReadFailed));
  assert.ok(markup.includes(inspectorCopy.readRetry));
  assert.doesNotMatch(markup, /Selection details/);
});

test('a run whose events could not be read is drawn, and marked as partial', () => {
  const markup = plain(
    render((client) => {
      client.setQueryData(workflowRunQueryKey(identity, 1), workflowRunDetailFixture());
      failed(client, workflowEventsQueryKey(identity, 1));
    }),
  );
  assert.match(markup, /data-run-read="partial"/);
  assert.ok(markup.includes(inspectorCopy.eventsReadFailed));
  assert.match(markup, /Selection details/);
});

test('a run read cleanly carries no warning', () => {
  const markup = render((client) => {
    client.setQueryData(workflowRunQueryKey(identity, 1), workflowRunDetailFixture());
    client.setQueryData(workflowEventsQueryKey(identity, 1), []);
  });
  assert.doesNotMatch(markup, /data-run-read=/);
});
