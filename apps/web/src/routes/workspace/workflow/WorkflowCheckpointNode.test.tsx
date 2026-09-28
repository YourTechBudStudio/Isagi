import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { WorkflowExecutionSummaryDto } from '@isagi/contracts';

import { elementAggregate, type ElementAggregate } from './aggregate.js';
import { inspectorCopy } from './copy.js';
import { visit } from './test-support.js';
import { CheckpointKindTag, CheckpointSubline } from './WorkflowCheckpointNode.js';

/** The canvas says only what the executions' summaries say, and a failed one is never a capture. */

function checkpointVisit(
  executionId: number,
  status: WorkflowExecutionSummaryDto['status'],
  checkpointId: number | null,
  retryOf: number | null = null,
): WorkflowExecutionSummaryDto {
  return visit({
    executionId,
    nodeId: 'save',
    nodeKind: 'checkpoint',
    status,
    checkpointId,
    retryOf,
  });
}

function aggregate(visits: readonly WorkflowExecutionSummaryDto[]): ElementAggregate {
  return {
    ...elementAggregate(null, 'save'),
    status: visits.at(-1)?.status ?? 'unvisited',
    visits,
  };
}

const subline = (title: string | undefined, of: ElementAggregate) =>
  renderToStaticMarkup(<CheckpointSubline title={title} aggregate={of} />);

test('the checkpoint kind tag is the cyan uppercase word', () => {
  const markup = renderToStaticMarkup(<CheckpointKindTag />);
  assert.match(markup, /text-cyan/);
  assert.match(markup, new RegExp(`>${inspectorCopy.checkpointKind}<`));
});

test('the subline names each state, with the static title only where it belongs', () => {
  assert.equal(subline('Plan', aggregate([])), `${inspectorCopy.notVisited} · Plan`);
  assert.match(subline('Plan', aggregate([checkpointVisit(1, 'running', null)])), /capturing/);
  assert.match(
    subline('Plan', aggregate([checkpointVisit(1, 'failed', null)])),
    new RegExp(inspectorCopy.checkpointFailed),
  );
  assert.equal(
    subline('Plan', aggregate([checkpointVisit(1, 'completed', 4)])),
    `${inspectorCopy.checkpointCaptured} · Plan`,
  );
  assert.equal(
    subline(
      'Plan',
      aggregate([checkpointVisit(1, 'completed', 4), checkpointVisit(2, 'completed', 5)]),
    ),
    inspectorCopy.checkpointCaptures(2),
  );
});

test('a retry that copied its checkpoint is not counted as a second capture', () => {
  assert.equal(
    subline(
      undefined,
      aggregate([checkpointVisit(1, 'failed', 4), checkpointVisit(2, 'completed', 4, 1)]),
    ),
    inspectorCopy.checkpointCaptured,
  );
});
