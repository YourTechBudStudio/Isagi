import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { ApiError, WorkflowRunSummary } from '@isagi/contracts';
import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from '@isagi/runtime-client';

import {
  paletteCopy,
  runtimeErrorCopy,
  workflowCopy,
  workflowEnvironmentCopy,
  workflowEnvironmentCreatedLine,
  workflowErrorStageHeadline,
} from '../../copy/index.js';
import { workflowSummaryFixture } from '../workspace/workflow/test-support.js';
import {
  workflowFailurePresentation,
  workflowLaunchOutcome,
  workflowRetryOutcome,
  workflowStartFailureContent,
  type WorkflowLaunchDeps,
} from './workflow-failure.js';

const failure = paletteCopy.workflows.failure;

function workflowRejected(
  data: Record<string, unknown>,
  requestId = 'req-1',
  message = 'diagnostic message',
): ApiError {
  return {
    code: 'workflow_rejected',
    status: 500,
    message,
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

test("a workflow's launch refusal keeps fixed copy and quotes its message in the diagnostic", () => {
  const refusal = "Launch this from an agent's pane.\n  (It drives the agent you launch it from.)";
  const apiError = workflowRejected(
    { reason: 'workflow_parse_rejected' },
    'req-parse',
    `  ${refusal}\n`,
  );
  const content = workflowStartFailureContent(new RuntimeApiError(apiError));

  assert.equal(content.title, paletteCopy.workflows.startRefused.title);
  assert.equal(content.body, runtimeErrorCopy.fromApiError(apiError));
  assert.ok(!content.body?.includes('agent'));
  // Verbatim, inner whitespace and all: only the ends are trimmed.
  assert.equal(
    content.diagnostic?.detail,
    `Workflow message: ${refusal}\n\nworkflow_rejected · request req-parse`,
  );
});

test('a launch refusal with no message keeps the plain diagnostic line', () => {
  const apiError = workflowRejected({ reason: 'workflow_parse_rejected' }, 'req-parse', '   ');
  const content = workflowStartFailureContent(new RuntimeApiError(apiError));

  assert.equal(content.title, paletteCopy.workflows.startRefused.title);
  assert.equal(content.body, runtimeErrorCopy.fromApiError(apiError));
  assert.equal(content.diagnostic?.detail, 'workflow_rejected · request req-parse');
});

test('parameters parse could not store keep a fixed body and put the runtime message in the diagnostic', () => {
  const message =
    "The workflow's parse returned a value that cannot be stored at parameters.when: a Date.";
  const apiError = workflowRejected({ reason: 'workflow_parameters_invalid' }, 'req-p', message);
  const content = workflowStartFailureContent(new RuntimeApiError(apiError));

  assert.equal(content.title, paletteCopy.workflows.startFailed.title);
  assert.equal(content.body, runtimeErrorCopy.fromApiError(apiError));
  assert.ok(!content.body?.includes(message));
  assert.equal(
    content.diagnostic?.detail,
    `Runtime message: ${message}\n\nworkflow_rejected · request req-p`,
  );
});

for (const reason of ['workflow_command_failed', 'workflow_placement_failed'] as const) {
  test(`${reason} keeps its fixed body and quotes the workflow's message only as a diagnostic`, () => {
    const message = 'origin.worktreeId is not a worktree I know';
    const apiError = workflowRejected({ reason }, 'req-hook', message);
    const content = workflowStartFailureContent(new RuntimeApiError(apiError));

    assert.equal(content.title, paletteCopy.workflows.startFailed.title);
    assert.equal(content.body, runtimeErrorCopy.fromApiError(apiError));
    assert.ok(!content.body?.includes(message));
    assert.equal(
      content.diagnostic?.detail,
      `Workflow message: ${message}\n\nworkflow_rejected · request req-hook`,
    );
  });
}

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
 * Preparation outcomes.
 *
 * Launch returns as soon as the run exists and preparation runs in the background, so the palette
 * waits for the run to leave `preparing` and reports what it did. The rules that matter: never name
 * a resource the run did not create, never offer Retry where the runtime will not take it, and
 * never let a cancelled preparation read as work still in progress.
 */

const environmentCopy = workflowEnvironmentCopy;

function summary(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return workflowSummaryFixture({ runId: 42, ...overrides });
}

const createPlacement: WorkflowRunSummary['placement'] = {
  source: 'selector',
  request: {
    worktree: { kind: 'create', branch: 'feat/story-44', fromRef: 'main' },
    surface: { kind: 'create', title: 'Implement story #44' },
  },
  baseCommit: '9f3e1c2a4b5d',
};

function failedPreparing(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return summary({
    status: 'failed',
    placement: createPlacement,
    worktreeId: null,
    worktreePath: null,
    surfaceId: null,
    error: { stage: 'environment', message: 'fatal: a branch named feat/story-44 already exists' },
    controls: { pause: false, resume: false, retry: true, cancel: false, dismiss: true },
    ...overrides,
  });
}

/** The three runtime calls, each failing loudly unless a test supplies it. */
function deps(overrides: Partial<WorkflowLaunchDeps> = {}): WorkflowLaunchDeps {
  return {
    start: () => Promise.resolve({ runId: 42 }),
    retry: () => Promise.reject(new Error('retry not expected')),
    awaitPrepared: () => Promise.reject(new Error('read not expected')),
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
      awaitPrepared: () => Promise.resolve(summary({ status: 'running' })),
      onPrepared: (runId) => recorded.push(runId),
    }),
  );
  assert.deepEqual(outcome, { kind: 'close' });
  assert.deepEqual(recorded, [42]);
});

test('a failed preparation names what it created, what Retry does, and that nothing was deleted', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      awaitPrepared: () =>
        Promise.resolve(
          failedPreparing({ worktreeId: 7, worktreePath: '/work/wt/feat-story-44', surfaceId: 9 }),
        ),
    }),
  );
  assert.equal(outcome.kind, 'error');
  const content = outcome.kind === 'error' ? outcome.content : null;
  assert.equal(content?.title, environmentCopy.preparationFailedTitle);
  const paragraphs = (content?.body ?? '').split('\n\n');
  assert.equal(paragraphs[0], workflowErrorStageHeadline('environment'));
  assert.equal(
    paragraphs[1],
    workflowEnvironmentCreatedLine({ worktreePath: '/work/wt/feat-story-44', surface: true }),
  );
  assert.equal(
    paragraphs[2],
    `${environmentCopy.retryKeepsWhatExists} ${environmentCopy.nothingDeleted}`,
  );
  // Git's own words are a framed diagnostic, never the sentence a person reads first.
  assert.equal(content?.diagnostic?.detail, 'fatal: a branch named feat/story-44 already exists');
  assert.deepEqual(
    content?.actions?.map((action) => action.value),
    ['retry', 'close'],
  );
});

test('a failure that created nothing says so and promises nothing about Retry', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({ awaitPrepared: () => Promise.resolve(failedPreparing()) }),
  );
  const content = outcome.kind === 'error' ? outcome.content : null;
  const paragraphs = (content?.body ?? '').split('\n\n');
  assert.deepEqual(paragraphs.slice(1), [environmentCopy.nothingCreated]);
});

test('a worktree the run was placed on already is not reported as created', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      awaitPrepared: () =>
        Promise.resolve(
          failedPreparing({
            placement: {
              source: 'override',
              request: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
              baseCommit: null,
            },
            worktreeId: 10,
            worktreePath: '/work/repo',
          }),
        ),
    }),
  );
  const content = outcome.kind === 'error' ? outcome.content : null;
  assert.ok((content?.body ?? '').includes(environmentCopy.nothingCreated));
});

test('Retry is offered only when the runtime says it will take one', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      awaitPrepared: () =>
        Promise.resolve(
          failedPreparing({
            controls: { pause: false, resume: false, retry: false, cancel: false, dismiss: true },
          }),
        ),
    }),
  );
  const content = outcome.kind === 'error' ? outcome.content : null;
  assert.equal(content?.actions, undefined);
});

test('a cancelled preparation is a warning that never reads as in progress, with Close only', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({
      awaitPrepared: () => Promise.resolve(summary({ status: 'cancelled', surfaceId: null })),
    }),
  );
  assert.equal(outcome.kind, 'result');
  const content = outcome.kind === 'result' ? outcome.content : null;
  assert.equal(content?.tone, 'warning');
  assert.equal(content?.title, environmentCopy.preparationCancelledTitle);
  assert.equal(content?.actions, undefined);
});

test('a retry that fails again offers Retry again, over the same mapping', async () => {
  let retries = 0;
  const launchDeps = deps({
    retry: () => {
      retries += 1;
      return Promise.resolve();
    },
    awaitPrepared: () =>
      Promise.resolve(retries < 2 ? failedPreparing() : summary({ status: 'running' })),
  });

  const first = await workflowLaunchOutcome(launchInput, launchDeps);
  const retryAction = first.kind === 'error' ? first.content.actions?.[0] : undefined;
  assert.ok(retryAction?.run);
  assert.deepEqual(retryAction.running, paletteCopy.workflows.retrying);

  const second = await retryAction.run();
  const secondRetry = second && second.kind === 'error' ? second.content.actions?.[0] : undefined;
  assert.ok(secondRetry?.run);

  assert.deepEqual(await secondRetry.run(), { kind: 'close' });
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
  const content = outcome.kind === 'error' ? outcome.content : null;
  assert.equal(content?.title, paletteCopy.workflows.startFailed.title);
  assert.equal(content?.actions, undefined);
});

test('a refused retry is reported as a retry failure, not as a failed start', async () => {
  const outcome = await workflowRetryOutcome(
    42,
    deps({
      retry: () =>
        Promise.reject(
          new RuntimeApiError(
            workflowRejected({ reason: 'workflow_control_unavailable', control: 'retry' }),
          ),
        ),
    }),
  );
  const content = outcome.kind === 'error' ? outcome.content : null;
  assert.equal(content?.title, workflowCopy.retryActionFailed);
  assert.equal(content?.actions, undefined);
});

test('a launch whose run could not be read never claims the workflow did not start', async () => {
  const outcome = await workflowLaunchOutcome(
    launchInput,
    deps({ awaitPrepared: () => Promise.reject(new RuntimeTransportError('socket gone', null)) }),
  );
  const content = outcome.kind === 'error' ? outcome.content : null;
  assert.equal(content?.title, environmentCopy.summaryUnreadableTitle);
  const paragraphs = (content?.body ?? '').split('\n\n');
  assert.equal(paragraphs[0], environmentCopy.summaryUnreadableBody);
  assert.equal(paragraphs[1], runtimeErrorCopy.transport);
  assert.deepEqual(
    content?.actions?.map((action) => action.value),
    ['read-again', 'close'],
  );
});

test('asking again after an unreadable run reports the run, not the read', async () => {
  let reads = 0;
  const launchDeps = deps({
    awaitPrepared: () => {
      reads += 1;
      return reads === 1
        ? Promise.reject(new RuntimeTransportError('socket gone', null))
        : Promise.resolve(summary({ status: 'running' }));
    },
  });
  const first = await workflowLaunchOutcome(launchInput, launchDeps);
  const readAgain = first.kind === 'error' ? first.content.actions?.[0] : undefined;
  assert.ok(readAgain?.run);
  assert.deepEqual(await readAgain.run(), { kind: 'close' });
  assert.equal(reads, 2);
});
