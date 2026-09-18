import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { ApiError, WorkflowRunSummary } from '@isagi/contracts';
import { workflowEnvironmentFailureReasonSchema } from '@isagi/contracts';

import {
  paletteCopy,
  runtimeErrorCopy,
  workflowCopy,
  workflowEnvironmentCopy,
  workflowEnvironmentFailureLine,
  workflowEnvironmentFailureRetryable,
} from '../../copy/index.js';
import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from '../runtime/client.js';
import { workflowSummaryFixture } from '../workspace/workflow/test-support.js';
import {
  workflowFailurePresentation,
  workflowLaunchOutcome,
  workflowRetryOutcome,
  workflowStartFailureContent,
  type WorkflowLaunchDeps,
} from './workflow-failure.js';

const failure = paletteCopy.workflows.failure;

function workflowRejected(data: Record<string, unknown>, requestId = 'req-1'): ApiError {
  return {
    code: 'workflow_rejected',
    status: 500,
    message: 'diagnostic message',
    requestId,
    data,
  } as ApiError;
}

const dbError = {
  code: 'runtime_database_failed',
  status: 500,
  message: 'db down',
  requestId: 'req-db',
  data: { operation: 'read' },
} satisfies ApiError;

test('a source-scan rejection becomes the discovery presentation with a framed source path', () => {
  const presentation = workflowFailurePresentation(
    new RuntimeApiError(
      workflowRejected(
        { reason: 'workflow_discovery_failed', workflowSourceDirectory: '/roots/extra' },
        'req-disc',
      ),
    ),
  );

  assert.equal(presentation.label, failure.discovery.label);
  assert.equal(presentation.sub, failure.discovery.sub);
  assert.equal(presentation.content.title, failure.discovery.title);
  assert.equal(presentation.content.body, failure.discovery.body);
  assert.equal(presentation.content.diagnostic?.label, failure.diagnosticLabel);
  assert.ok(presentation.content.diagnostic?.detail.includes('Source directory: /roots/extra'));
  assert.ok(presentation.content.diagnostic?.detail.includes('request req-disc'));
});

test('discovery classification unwraps an Effect fiber failure', async () => {
  const wrapped = await Effect.runPromise(
    Effect.fail(
      new RuntimeApiError(
        workflowRejected({ reason: 'workflow_discovery_failed', workflowSourceDirectory: '/r' }),
      ),
    ),
  ).catch((cause: unknown) => cause);
  assert.equal(workflowFailurePresentation(wrapped).content.title, failure.discovery.title);
});

test('a non-discovery workflow rejection uses generic chrome with reason-specific body', () => {
  const apiError = workflowRejected({ reason: 'workflow_surface_busy' }, 'req-busy');
  const presentation = workflowFailurePresentation(new RuntimeApiError(apiError));

  assert.equal(presentation.label, failure.generic.label);
  assert.equal(presentation.content.title, failure.generic.title);
  assert.equal(presentation.content.body, runtimeErrorCopy.fromApiError(apiError));
  assert.notEqual(presentation.content.body, failure.generic.body);
  assert.equal(presentation.content.diagnostic?.detail, 'workflow_rejected · request req-busy');
});

test('a non-workflow API error uses generic chrome with a code/request diagnostic', () => {
  const presentation = workflowFailurePresentation(new RuntimeApiError(dbError));
  assert.equal(presentation.content.body, runtimeErrorCopy.fromApiError(dbError));
  assert.equal(presentation.content.diagnostic?.detail, 'runtime_database_failed · request req-db');
});

test('a transport failure is generic with transport body and no diagnostic', () => {
  const presentation = workflowFailurePresentation(new RuntimeTransportError('down', null));
  assert.equal(presentation.content.body, runtimeErrorCopy.transport);
  assert.equal(presentation.content.diagnostic, undefined);
});

test('a decode failure frames the endpoint as diagnostic evidence', () => {
  const presentation = workflowFailurePresentation(
    new RuntimeDecodeError('workflows.descriptors', null),
  );
  assert.equal(presentation.content.body, runtimeErrorCopy.decode);
  assert.equal(presentation.content.diagnostic?.detail, 'Endpoint: workflows.descriptors');
});

test('an unexpected failure invents no scan cause and no diagnostic', () => {
  const presentation = workflowFailurePresentation(new Error('boom'));
  assert.equal(presentation.content.body, failure.generic.body);
  assert.equal(presentation.content.diagnostic, undefined);
});

test('start failure keeps structured paths for API errors', () => {
  const apiError = workflowRejected(
    {
      reason: 'workflow_load_failed',
      workflowLoadFailureReason: 'artifact_tampered',
      workflowPackageDirectory: '/winner/release',
      shadowedWorkflowPackageDirectories: ['/lower/release'],
    },
    'req-start',
  );
  const content = workflowStartFailureContent(new RuntimeApiError(apiError));

  assert.equal(content.title, paletteCopy.workflows.startFailed.title);
  assert.equal(content.body, runtimeErrorCopy.fromApiError(apiError));
  assert.equal(content.diagnostic?.label, paletteCopy.workflows.startFailed.diagnosticLabel);
  assert.ok(content.diagnostic?.detail.includes('Workflow package: /winner/release'));
  assert.ok(content.diagnostic?.detail.includes('Shadowed package: /lower/release'));
  assert.ok(content.diagnostic?.detail.includes('request req-start'));
});

test('start failure omits the diagnostic for transport and unknown, frames endpoint for decode', () => {
  const transport = workflowStartFailureContent(new RuntimeTransportError('down', null));
  assert.equal(transport.body, runtimeErrorCopy.transport);
  assert.equal(transport.diagnostic, undefined);

  const unknown = workflowStartFailureContent(new Error('boom'));
  assert.equal(unknown.body, runtimeErrorCopy.unknown);
  assert.equal(unknown.diagnostic, undefined);

  const decode = workflowStartFailureContent(new RuntimeDecodeError('workflows.start', null));
  assert.equal(decode.body, runtimeErrorCopy.decode);
  assert.equal(decode.diagnostic?.detail, 'Endpoint: workflows.start');
});

/**
 * What a launch says about preparing its environment.
 *
 * Every sentence here is formed on the web from a reason code and the receipts, so these tests are
 * the only place the wording is checked against the facts it claims. The rules that matter: never
 * name a resource the run did not record, never offer Retry where it cannot work, and never let a
 * cancelled preparation read as work still in progress.
 */

const environmentCopy = workflowEnvironmentCopy;

function preparedSummary(
  preparation: Partial<WorkflowRunSummary['preparation']> = {},
): WorkflowRunSummary {
  return workflowSummaryFixture({
    runId: 42,
    preparation: { ...workflowSummaryFixture().preparation, ...preparation },
  });
}

const worktreeReceipt = {
  acquisition: 'created',
  worktreeId: 7,
  worktreePath: '/home/dev/.isagi/worktrees/1/ab12cd',
  branch: 'feat/story-44',
  recordedAt: '2026-09-15T10:00:00.000Z',
} as const;

const surfaceReceipt = {
  surfaceId: 9,
  requestedTitle: 'Implement story #44',
  title: 'Implement story #44',
  recordedAt: '2026-09-15T10:00:00.000Z',
} as const;

/**
 * The three runtime calls, each failing loudly unless a test supplies it.
 *
 * They are separate here for the same reason they are separate in the adapter: which one a test
 * makes fail is exactly what decides which sentence the person should see.
 */
function deps(overrides: Partial<WorkflowLaunchDeps> = {}): WorkflowLaunchDeps {
  return {
    start: () => Promise.resolve({ runId: 42 }),
    retry: () => Promise.reject(new Error('retry not expected')),
    readSummary: () => Promise.reject(new Error('read not expected')),
    ...overrides,
  };
}

const launchInput = {
  workflowKey: 'review',
  inputs: {},
  origin: { worktreeId: 1, surfaceId: 2, paneId: null, agentSessionId: null },
} as const;

test('a prepared launch closes the palette and records the entry', async () => {
  const recorded: number[] = [];
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      readSummary: () => Promise.resolve(preparedSummary({ status: 'prepared' })),
      onPrepared: (runId) => recorded.push(runId),
    }),
  );

  assert.deepEqual(outcome, { kind: 'close' });
  // Only a launch that actually got somewhere is worth offering back at the top of the palette.
  assert.deepEqual(recorded, [42]);
});

test('a failed preparation names what exists, what Retry does, and that nothing was deleted', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      readSummary: () =>
        Promise.resolve(
          preparedSummary({
            status: 'failed',
            worktree: worktreeReceipt,
            surface: surfaceReceipt,
            setup: {
              status: 'failed',
              reason: null,
              setupRunId: 3,
              failure: {
                hookIndex: 2,
                hookType: 'command',
                message: 'exit 1',
                exitCode: 1,
                outputExcerpt: 'ERR_PNPM_OUTDATED_LOCKFILE',
              },
              recordedAt: '2026-09-15T10:00:00.000Z',
            },
            failure: { step: 'setup', reason: 'setup_failed', diagnostic: 'exit code 1' },
          }),
        ),
    }),
  );

  assert.equal(outcome.kind, 'error');
  const content = outcome.kind === 'error' ? outcome.content : null;
  assert.equal(content?.title, environmentCopy.preparationFailedTitle);
  const body = content?.body ?? '';
  const paragraphs = body.split('\n\n');
  assert.equal(paragraphs.length, 3);
  assert.equal(paragraphs[0], "Setup hook 2 (command) didn't finish.");
  assert.ok(
    paragraphs[1]?.includes('the worktree feat/story-44 at /home/dev/.isagi/worktrees/1/ab12cd'),
  );
  assert.ok(paragraphs[1]?.includes('the surface "Implement story #44"'));
  assert.equal(
    paragraphs[2],
    `${environmentCopy.retryFromSetup} ${environmentCopy.nothingDeleted}`,
  );
  // Raw hook output is framed as diagnostic detail, never as the headline.
  assert.equal(content?.diagnostic?.label, environmentCopy.setupOutputLabel);
  assert.equal(content?.diagnostic?.detail, 'exit code 1');
  assert.deepEqual(
    content?.actions?.map((action) => action.value),
    ['retry', 'close'],
  );
  assert.equal(content?.actions?.[0]?.intent, 'primary');
});

test('a failure that allocated nothing says so, and offers no retry line it cannot justify', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      readSummary: () =>
        Promise.resolve(
          preparedSummary({
            status: 'failed',
            failure: { step: 'commit', reason: 'surface_busy', occupyingRunId: 41 },
          }),
        ),
    }),
  );

  const content = outcome.kind === 'error' ? outcome.content : null;
  const paragraphs = (content?.body ?? '').split('\n\n');
  assert.equal(paragraphs.length, 2);
  assert.ok(paragraphs[0]?.includes('run #41'));
  assert.equal(paragraphs[1], environmentCopy.nothingCreated);
  // Nothing exists, so there is nothing to promise was kept.
  assert.ok(!(content?.body ?? '').includes(environmentCopy.nothingDeleted));
  assert.equal(content?.diagnostic, undefined);
  // Retry is still offered: the person may have dismissed the occupying run since.
  assert.equal(content?.actions?.[0]?.value, 'retry');
});

test('a failure the summary could not describe does not invent a cause', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      readSummary: () => Promise.resolve(preparedSummary({ status: 'failed', failure: null })),
    }),
  );

  const content = outcome.kind === 'error' ? outcome.content : null;
  assert.equal((content?.body ?? '').split('\n\n')[0], environmentCopy.preparationReasonUnknown);
  // The three causes of a missing detail include a still-retryable recovered state.
  assert.equal(content?.actions?.[0]?.value, 'retry');
});

test('a cancelled preparation is a warning that never reads as in progress, with Close only', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      readSummary: () =>
        Promise.resolve(preparedSummary({ status: 'cancelled', worktree: worktreeReceipt })),
    }),
  );

  assert.equal(outcome.kind, 'result');
  const content = outcome.kind === 'result' ? outcome.content : null;
  assert.equal(content?.tone, 'warning');
  assert.equal(content?.title, environmentCopy.preparationCancelledTitle);
  const paragraphs = (content?.body ?? '').split('\n\n');
  assert.equal(paragraphs[0], environmentCopy.preparationCancelledBody);
  assert.ok(paragraphs[1]?.includes('the worktree feat/story-44'));
  assert.equal(paragraphs[2], environmentCopy.nothingDeleted);
  // A terminal run has nothing to retry and no attachment to dismiss.
  assert.equal(content?.actions, undefined);
});

test('a worktree receipt without a branch is named by its path alone', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      readSummary: () =>
        Promise.resolve(
          preparedSummary({
            status: 'cancelled',
            worktree: { ...worktreeReceipt, branch: null },
          }),
        ),
    }),
  );

  const body = outcome.kind === 'result' ? (outcome.content.body ?? '') : '';
  assert.ok(body.includes('the worktree at /home/dev/.isagi/worktrees/1/ab12cd'));
});

test('every environment failure reason has its own sentence', () => {
  const reasons = [...workflowEnvironmentFailureReasonSchema.literals];
  const lines = new Set<string>();
  for (const reason of reasons) {
    const line = workflowEnvironmentFailureLine(reason);
    assert.ok(line.length > 0, `missing copy: ${reason}`);
    assert.notEqual(line, environmentCopy.preparationReasonUnknown, `fallback copy: ${reason}`);
    lines.add(line);
  }
  // Distinct sentences, because two reasons that read identically would send a person to the wrong
  // place; the type checker guarantees the set is complete, this guarantees it is useful.
  assert.equal(lines.size, reasons.length);
});

test('a reason that can name an identity reads as a whole sentence without one', () => {
  assert.ok(
    workflowEnvironmentFailureLine('branch_exists', { branch: 'feat/x' }).startsWith(
      "Branch feat/x already exists, so Isagi didn't create a worktree from it.",
    ),
  );
  assert.ok(workflowEnvironmentFailureLine('branch_exists').startsWith('That branch'));
  assert.ok(workflowEnvironmentFailureLine('setup_failed').startsWith('A setup hook'));
  assert.ok(workflowEnvironmentFailureLine('surface_busy').startsWith('That surface'));
});

test('a retry that fails again offers Retry again, over the same mapping', async () => {
  const failed = preparedSummary({ status: 'failed', worktree: worktreeReceipt, failure: null });
  let retries = 0;
  const launchDeps = deps({
    retry: () => {
      retries += 1;
      return Promise.resolve();
    },
    readSummary: () =>
      Promise.resolve(retries < 2 ? failed : preparedSummary({ status: 'prepared' })),
  });

  const first = await workflowLaunchOutcome(launchInput, launchDeps);
  const retryAction = first.kind === 'error' ? first.content.actions?.[0] : undefined;
  assert.ok(retryAction?.run);
  assert.deepEqual(retryAction.running, paletteCopy.workflows.retrying);

  const second = await retryAction.run();
  assert.equal(second && second.kind, 'error');
  const secondRetry = second && second.kind === 'error' ? second.content.actions?.[0] : undefined;
  assert.ok(secondRetry?.run);

  const third = await secondRetry.run();
  assert.deepEqual(third, { kind: 'close' });
  assert.equal(retries, 2);
});

test('a launch rejected before any run offers no Retry, because nothing changed by itself', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      start: () =>
        Promise.reject(
          new RuntimeApiError(
            workflowRejected({ reason: 'workflow_environment_collision', collision: 'branch' }),
          ),
        ),
    }),
  );

  assert.equal(outcome.kind, 'error');
  const content = outcome.kind === 'error' ? outcome.content : null;
  assert.equal(content?.title, paletteCopy.workflows.startFailed.title);
  assert.equal(content?.actions, undefined);
});

test('a refused retry is reported as a retry failure, not as a failed start', async () => {
  const outcome = await workflowRetryOutcome(
    42,
    deps({
      retry: () =>
        Promise.reject(new RuntimeApiError(workflowRejected({ reason: 'workflow_stale_control' }))),
    }),
  );

  const content = outcome.kind === 'error' ? outcome.content : null;
  assert.equal(content?.title, workflowCopy.retryActionFailed);
  // The runtime has said this run moved on; a second Retry would be a button guaranteed to fail.
  assert.equal(content?.actions, undefined);
});

test('a preparation still pending after an awaited launch says only what is true', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({ readSummary: () => Promise.resolve(preparedSummary({ status: 'pending' })) }),
  );

  assert.equal(outcome.kind, 'result');
  const content = outcome.kind === 'result' ? outcome.content : null;
  assert.equal(content?.title, workflowEnvironmentCopy.preparationPendingTitle);
  assert.equal(content?.actions, undefined);
});

test('a launch whose summary could not be read never claims the workflow did not start', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      readSummary: () => Promise.reject(new RuntimeTransportError('socket gone', null)),
    }),
  );

  assert.equal(outcome.kind, 'error');
  const content = outcome.kind === 'error' ? outcome.content : null;
  // The launch went through: saying otherwise would deny a prepared run with a live attachment.
  assert.equal(content?.title, workflowEnvironmentCopy.summaryUnreadableTitle);
  assert.notEqual(content?.title, paletteCopy.workflows.startFailed.title);
  const paragraphs = (content?.body ?? '').split('\n\n');
  assert.equal(paragraphs[0], workflowEnvironmentCopy.summaryUnreadableBody);
  assert.equal(paragraphs[1], runtimeErrorCopy.transport);
  // Nothing about the run has to change first, so the action is simply to ask again.
  assert.deepEqual(
    content?.actions?.map((action) => action.value),
    ['read-again', 'close'],
  );
});

test('asking again after an unreadable summary reports the run, not the read', async () => {
  let reads = 0;
  const launchDeps = deps({
    readSummary: () => {
      reads += 1;
      return reads === 1
        ? Promise.reject(new RuntimeTransportError('socket gone', null))
        : Promise.resolve(preparedSummary({ status: 'prepared' }));
    },
  });

  const first = await workflowLaunchOutcome(launchInput, launchDeps);
  const readAgain = first.kind === 'error' ? first.content.actions?.[0] : undefined;
  assert.ok(readAgain?.run);
  assert.deepEqual(readAgain.running, paletteCopy.workflows.readingRun);

  assert.deepEqual(await readAgain.run(), { kind: 'close' });
  assert.equal(reads, 2);
});

test('an accepted retry whose summary could not be read is not reported as a refused retry', async () => {
  const outcome = await workflowRetryOutcome(
    42,
    deps({
      retry: () => Promise.resolve(),
      readSummary: () => Promise.reject(new RuntimeTransportError('socket gone', null)),
    }),
  );

  const content = outcome.kind === 'error' ? outcome.content : null;
  assert.equal(content?.title, workflowEnvironmentCopy.summaryUnreadableTitle);
  assert.notEqual(content?.title, workflowCopy.retryActionFailed);
});

test('a reason Retry cannot change offers Close only, and names the real next move', async () => {
  for (const reason of [
    'worktree_missing',
    'surface_missing',
    'surface_not_on_worktree',
  ] as const) {
    const outcome = await workflowLaunchOutcome(
      launchInput,
      deps({
        readSummary: () =>
          Promise.resolve(
            preparedSummary({
              status: 'failed',
              // A worktree was created before the surface step failed, so the "what exists" and
              // "nothing was deleted" sentences are still owed — only the Retry line is not.
              worktree: worktreeReceipt,
              failure: { step: 'surface', reason },
            }),
          ),
      }),
    );

    const content = outcome.kind === 'error' ? outcome.content : null;
    // Retry would replay the same recorded request against the same missing row.
    assert.equal(content?.actions, undefined, reason);
    const paragraphs = (content?.body ?? '').split('\n\n');
    assert.ok(paragraphs[0]?.includes('start the workflow again'), reason);
    assert.ok(paragraphs[1]?.includes('the worktree feat/story-44'), reason);
    // What Retry would do is not described, because Retry is not on the panel.
    assert.equal(paragraphs[2], workflowEnvironmentCopy.nothingDeleted, reason);
    assert.ok(!(content?.body ?? '').includes('Retry'), reason);
  }
});

test('a reason the person can act on keeps Retry', async () => {
  for (const reason of ['branch_exists', 'setup_failed', 'surface_busy', 'interrupted'] as const) {
    const outcome = await workflowLaunchOutcome(
      launchInput,
      deps({
        readSummary: () =>
          Promise.resolve(
            preparedSummary({ status: 'failed', failure: { step: 'worktree', reason } }),
          ),
      }),
    );

    const content = outcome.kind === 'error' ? outcome.content : null;
    assert.equal(content?.actions?.[0]?.value, 'retry', reason);
  }
});

test('retryability is a fact about the reason, and every reason states it', () => {
  const reasons = [...workflowEnvironmentFailureReasonSchema.literals];
  const unretryable = reasons.filter((reason) => !workflowEnvironmentFailureRetryable(reason));

  // Exactly the three that name a row Retry cannot bring back. A new contract reason must decide
  // this deliberately, which the exhaustive map forces.
  assert.deepEqual(unretryable.toSorted(), [
    'surface_missing',
    'surface_not_on_worktree',
    'worktree_missing',
  ]);
  // Each of them ends with the move that can actually work.
  for (const reason of unretryable) {
    assert.ok(
      workflowEnvironmentFailureLine(reason).includes('start the workflow again'),
      `no next move: ${reason}`,
    );
  }
});
