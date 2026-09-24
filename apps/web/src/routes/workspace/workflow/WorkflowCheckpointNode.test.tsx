import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { WorkflowExecutionCheckpointDto, WorkflowExecutionDto } from '@isagi/contracts';

import { elementAggregate, type ElementAggregate, type ElementStatus } from './aggregate.js';
import { inspectorCopy } from './copy.js';
import { buildDockView, type DockRow } from './dock.js';
import {
  descriptorFixture,
  graphFixture,
  runStateFixture,
  clockAt,
  visit,
} from './test-support.js';
import { buildTopology } from './topology.js';
import { CheckpointKindTag, CheckpointSubline } from './WorkflowCheckpointNode.js';

/**
 * A checkpoint on the declared canvas and in the declared dock, from data already on screen.
 *
 * The canvas says only what the visits' status and summaries say — never a count of files, a
 * warning, or a per-visit title — and a failed visit is never counted as a capture.
 */

const saved = (checkpointId: string): WorkflowExecutionCheckpointDto => ({
  checkpointId,
  title: 'Phase saved',
  base: { kind: 'none', reason: 'folder_project' },
  counts: { scopes: 1, files: 2, absences: 0, warnings: 0 },
});

function checkpointVisit(
  executionId: number,
  status: WorkflowExecutionDto['status'],
  checkpoint: WorkflowExecutionCheckpointDto | null,
): WorkflowExecutionDto {
  return visit({ executionId, nodeId: 'save', nodeKind: 'checkpoint', status, checkpoint });
}

/** A visit whose attempt a Cancel ended while the visit itself still reads as running. */
function cancelledVisit(
  executionId: number,
  checkpoint: WorkflowExecutionCheckpointDto | null,
): WorkflowExecutionDto {
  return {
    ...checkpointVisit(executionId, 'running', checkpoint),
    latestAttempt: {
      attemptId: executionId,
      attemptIndex: 1,
      artifactHash: 'sha256:pin-1',
      status: 'cancelled',
      invocationKind: 'initial',
      failure: null,
      recoveryMode: checkpoint === null ? 'rerun_producer' : 'reuse_producer_output',
      producerArtifactHash: checkpoint === null ? null : 'sha256:pin-1',
    },
  };
}

function aggregate(
  status: ElementStatus,
  visits: readonly WorkflowExecutionDto[],
): ElementAggregate {
  return { ...elementAggregate(null, 'save'), status, visits };
}

const subline = (title: string | undefined, of: ElementAggregate) =>
  renderToStaticMarkup(<CheckpointSubline title={title} aggregate={of} />);

test('the checkpoint kind tag is the cyan uppercase word', () => {
  const markup = renderToStaticMarkup(<CheckpointKindTag />);
  assert.match(markup, /text-cyan/);
  assert.match(markup, /uppercase/);
  assert.match(markup, new RegExp(`>${inspectorCopy.checkpointKind}<`));
});

test('the subline names each aggregate state, with the static title only where it belongs', () => {
  assert.equal(
    subline('Save the phase', aggregate('unvisited', [])),
    'not visited · Save the phase',
  );
  assert.equal(subline(undefined, aggregate('unvisited', [])), 'not visited');

  assert.match(
    subline('Save the phase', aggregate('running', [checkpointVisit(1, 'running', null)])),
    />capturing…</,
  );

  assert.equal(
    subline(
      'Save the phase',
      aggregate('completed', [checkpointVisit(1, 'completed', saved('wcp_a'))]),
    ),
    'captured · Save the phase',
  );
  assert.equal(
    subline(undefined, aggregate('completed', [checkpointVisit(1, 'completed', saved('wcp_a'))])),
    'captured',
  );

  assert.equal(
    subline(
      'Save the phase',
      aggregate('completed', [
        checkpointVisit(1, 'completed', saved('wcp_a')),
        checkpointVisit(2, 'completed', saved('wcp_b')),
        checkpointVisit(3, 'completed', saved('wcp_c')),
      ]),
    ),
    '3 captures',
  );
});

test('a failed visit is not a capture, and the latest failure speaks over earlier saves', () => {
  // Failed, then repaired by a later visit that saved: one capture.
  assert.equal(
    subline(
      'Save the phase',
      aggregate('completed', [
        checkpointVisit(1, 'failed', null),
        checkpointVisit(2, 'completed', saved('wcp_b')),
      ]),
    ),
    'captured · Save the phase',
  );
  // Saved, then the latest visit failed: the failure is what the node says now.
  const failed = subline(
    'Save the phase',
    aggregate('failed', [
      checkpointVisit(1, 'completed', saved('wcp_a')),
      checkpointVisit(2, 'failed', null),
    ]),
  );
  assert.match(failed, />capture failed</);
  assert.match(failed, /text-error/);
});

test('a cancelled visit is never still capturing: it saved a checkpoint or it saved nothing', () => {
  // Cancelled after the row committed: the retained checkpoint is a capture.
  assert.equal(
    subline('Save the phase', aggregate('running', [cancelledVisit(1, saved('wcp_a'))])),
    'captured · Save the phase',
  );
  assert.equal(
    subline(
      'Save the phase',
      aggregate('running', [
        checkpointVisit(1, 'completed', saved('wcp_a')),
        cancelledVisit(2, saved('wcp_b')),
      ]),
    ),
    '2 captures',
  );
  // Cancelled before anything was saved.
  const nothing = subline('Save the phase', aggregate('running', [cancelledVisit(1, null)]));
  assert.equal(nothing, inspectorCopy.checkpointNothingSaved);
  assert.doesNotMatch(nothing, /capturing/);

  // Saved earlier, then the latest visit was cancelled before saving: the node describes its latest
  // visit, as a latest failure does. The earlier checkpoint stays in history.
  const afterSave = subline(
    'Save the phase',
    aggregate('running', [
      checkpointVisit(1, 'completed', saved('wcp_a')),
      cancelledVisit(2, null),
    ]),
  );
  assert.equal(afterSave, inspectorCopy.checkpointNothingSaved);
  assert.doesNotMatch(afterSave, /capturing/);
});

const fields = (rows: readonly DockRow[]) =>
  rows.filter((row): row is Exclude<DockRow, { gap: true }> => !('gap' in row));

test('the declared dock shows kind, id, graph and title, then its edge, and no description', () => {
  const topology = buildTopology(
    descriptorFixture(
      [
        graphFixture({
          key: 'root',
          entry: 'save',
          nodes: [
            {
              id: 'save',
              kind: 'checkpoint',
              title: 'Save the phase',
              description: 'The phase directory.',
            },
          ],
          edges: [{ id: 'save-out', from: 'save', to: ['done'] }],
          outcomes: [{ id: 'done', kind: 'success' }],
        }),
      ],
      'root',
    ),
  );
  const view = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    state: runStateFixture({ executions: [checkpointVisit(1, 'completed', saved('wcp_a'))] }),
    topology,
    now: clockAt(10),
  });
  assert.deepEqual(
    fields(view!.declared).map((row) => [row.label, row.value]),
    [
      ['kind', 'checkpoint'],
      ['id', 'save'],
      ['graph', 'root'],
      ['title', 'Save the phase'],
      ['edge', 'save-out'],
      ['to', 'done'],
    ],
  );
});
