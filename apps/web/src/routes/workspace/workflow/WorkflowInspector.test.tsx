import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';
import { renderToStaticMarkup } from 'react-dom/server';

import type { RuntimeApiShape } from '../../../lib/runtime/client.js';
import { AppStateProvider } from '../../../lib/state/AppStateProvider.js';
import { makeTestRegistry } from '../../../lib/state/testing.js';
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

const unreachable = () => Effect.fail(new Error('unreachable')) as never;

function render(api: Partial<RuntimeApiShape>): string {
  // Synchronous fakes answer on the first read, so the static render shows what they said. The
  // structure read never answers: the declared tab is not what these tests look at.
  const registry = makeTestRegistry({
    retry: false,
    api: { getWorkflowStructure: () => Effect.never, ...api },
  });
  try {
    return renderToStaticMarkup(
      <AppStateProvider registry={registry}>
        <WorkflowInspector summary={workflowSummaryFixture()} bottomInset={0} onClose={() => {}} />
      </AppStateProvider>,
    );
  } finally {
    registry.dispose();
  }
}

const plain = (markup: string) => markup.replaceAll('&#x27;', "'");

test('a run that could not be read says so, with a retry, instead of drawing an empty run', () => {
  const markup = plain(
    render({
      getWorkflowRun: unreachable,
      listWorkflowEvents: () => Effect.succeed({ items: [], nextCursor: null }),
    }),
  );
  assert.match(markup, /data-run-read="failed"/);
  assert.ok(markup.includes(inspectorCopy.runReadFailed));
  assert.ok(markup.includes(inspectorCopy.readRetry));
  assert.doesNotMatch(markup, /Selection details/);
});

test('a run whose events could not be read is drawn, and marked as partial', () => {
  const markup = plain(
    render({
      getWorkflowRun: () => Effect.succeed(workflowRunDetailFixture()),
      listWorkflowEvents: unreachable,
    }),
  );
  assert.match(markup, /data-run-read="partial"/);
  assert.ok(markup.includes(inspectorCopy.eventsReadFailed));
  assert.match(markup, /Selection details/);
});

test('a run read cleanly carries no warning', () => {
  const markup = render({
    getWorkflowRun: () => Effect.succeed(workflowRunDetailFixture()),
    listWorkflowEvents: () => Effect.succeed({ items: [], nextCursor: null }),
  });
  assert.doesNotMatch(markup, /data-run-read=/);
});
