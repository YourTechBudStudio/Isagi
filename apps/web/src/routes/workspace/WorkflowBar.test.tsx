import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import type { WorkflowRunSummary } from '@isagi/contracts';

import { workflowCopy } from '../../copy/index.js';
import type { WorkflowLogView } from '../../lib/workspace/workflow/queries.js';
import { workflowSummaryFixture } from '../../lib/workspace/workflow/test-support.js';
import { WorkflowBar, type WorkflowBarProps } from './WorkflowBar.js';

/**
 * What the bar shows, given facts.
 *
 * Interaction lives in the browser suite; this covers the part that is a pure function of the
 * summary — which controls exist, what a failure says, and whether the copy tells the truth about
 * what a stop actually did.
 */

test('the controls offered are exactly the ones the runtime says it will accept', () => {
  const markup = render({
    summary: workflowSummaryFixture({
      controls: {
        pause: false,
        resume: true,
        retry: true,
        cancel: false,
        dismiss: true,
        advance: false,
      },
    }),
  });

  assert.match(markup, /aria-label="Resume"/);
  assert.match(markup, /aria-label="Retry"/);
  assert.match(markup, new RegExp(`aria-label="${workflowCopy.dismissLabel}"`));
  // Availability comes from the runtime, so a control it would refuse is not drawn at all.
  assert.doesNotMatch(markup, /aria-label="Pause"/);
  assert.doesNotMatch(markup, /aria-label="Cancel"/);
});

test('Cancel and Dismiss are separate controls with separate meanings', () => {
  const running = render({
    summary: workflowSummaryFixture({
      controls: { ...controls(), cancel: true, dismiss: false },
    }),
  });
  assert.match(running, /aria-label="Cancel"/);
  assert.doesNotMatch(running, new RegExp(`aria-label="${workflowCopy.dismissLabel}"`));

  const finished = render({
    summary: workflowSummaryFixture({
      status: 'done',
      controls: { ...controls(), pause: false, cancel: false, dismiss: true },
    }),
  });
  assert.doesNotMatch(finished, /aria-label="Cancel"/);
  assert.match(finished, new RegExp(`aria-label="${workflowCopy.dismissLabel}"`));
});

test('the cancel confirmation never claims the workflow is cleared', () => {
  // The mock's old sentence said the workflow is "cleared", which is two untruths: nothing is
  // deleted, and external work is not guaranteed to stop.
  assert.doesNotMatch(workflowCopy.cancelConfirmDetail, /clear/i);
  assert.match(workflowCopy.cancelConfirmDetail, /records everything so far/);
  assert.match(workflowCopy.cancelConfirmDetail, /may keep running, or stop part-way/);
  assert.match(workflowCopy.dismissDetail, /history stay/);
});

test('an authored failure outcome is not presented as something to repair', () => {
  const markup = render({
    summary: workflowSummaryFixture({
      status: 'failed',
      outcome: {
        outcomeId: 'rejected',
        kind: 'failure',
        reason: 'The reviewer rejected the draft.',
        producedRef: null,
      },
      controls: { ...controls(), pause: false, cancel: false, dismiss: true },
    }),
  });

  assert.match(markup, /The reviewer rejected the draft\./);
  assert.doesNotMatch(markup, /aria-label="Retry"/);
});

test('a segment failure shows Isagi’s sentence and keeps the runtime’s own text as diagnostic', () => {
  const markup = render({
    summary: workflowSummaryFixture({
      status: 'failed',
      failure: {
        code: 'node_callback_failed',
        message: 'TypeError: cannot read property draft of undefined',
        segmentKind: 'node_callback',
        attemptId: 3,
        frameId: 1,
        executionId: 2,
      },
      controls: { ...controls(), pause: false, cancel: false, retry: true, dismiss: true },
    }),
  });

  assert.match(markup, /A step in this workflow threw\./);
  assert.match(markup, /node_callback_failed/);
  assert.match(markup, /cannot read property draft of undefined/);
  assert.match(markup, /aria-label="Retry"/);
});

test('a blocked run says what is holding it, and reads as needing attention rather than an answer', () => {
  const markup = render({
    summary: workflowSummaryFixture({
      status: 'blocked',
      blockedOperation: { operationKey: 'op-1', frameId: 1, executionId: 2 },
    }),
  });
  assert.match(markup, /Blocked/);
  assert.match(markup, new RegExp(escape(workflowCopy.blockedOperation)));
});

test('an incomplete stop stays visible instead of reading as a clean cancel', () => {
  const markup = render({
    summary: workflowSummaryFixture({
      status: 'cancelled',
      stopSummary: { requested: 2, confirmed: 1, failed: 0, unsupported: 1, pending: 0 },
      controls: { ...controls(), pause: false, cancel: false, dismiss: true },
    }),
  });
  assert.match(markup, /Cancelled/);
  assert.match(markup, new RegExp(escape(workflowCopy.stopUnsupported)));
});

test('a paused run with a pending question says the answer will not restart it', () => {
  const markup = render({
    summary: workflowSummaryFixture({
      paused: true,
      status: 'waiting',
      blockingWait: {
        waitId: 5,
        kind: 'user_continue',
        label: 'Ready for review?',
        frameId: 1,
        executionId: 2,
        questions: null,
        armedAt: '2026-09-15T10:00:00.000Z',
      },
      controls: { ...controls(), pause: false, resume: true, advance: true },
    }),
  });

  assert.match(markup, /Ready for review\?/);
  assert.match(markup, new RegExp(escape(workflowCopy.continuePrompt)));
  assert.match(markup, new RegExp(escape(workflowCopy.pausedAnswerNote)));
});

test('a wait the runtime will not accept an answer for shows no form', () => {
  const markup = render({
    summary: workflowSummaryFixture({
      status: 'waiting',
      blockingWait: {
        waitId: 5,
        kind: 'user_input',
        label: null,
        frameId: 1,
        executionId: 2,
        questions: null,
        armedAt: '2026-09-15T10:00:00.000Z',
      },
      controls: { ...controls(), advance: false },
    }),
  });
  assert.doesNotMatch(markup, new RegExp(escape(workflowCopy.continuePrompt)));
});

test('the log states that it is a window, rather than implying it holds everything', () => {
  const markup = render({
    logExpanded: true,
    log: {
      ...emptyLog(),
      lines: [
        {
          revision: 12,
          recordedAt: '2026-09-15T10:00:12.000Z',
          tone: 'info',
          label: 'log',
          body: 'Drafting the summary.',
          diagnostic: null,
          storedDetail: null,
        },
      ],
      hasOlder: true,
    },
  });

  assert.match(markup, /Drafting the summary\./);
  assert.match(markup, new RegExp(escape(workflowCopy.logOlderAvailable)));
  assert.match(markup, new RegExp(escape(workflowCopy.logLoadEarlier)));
});

test('an empty log on a dropped connection does not read as a quiet run', () => {
  const markup = render({ logExpanded: true, connection: 'disconnected' });
  assert.match(markup, new RegExp(escape(workflowCopy.logDisconnected)));
  assert.doesNotMatch(markup, new RegExp(escape(workflowCopy.logEmpty)));
});

test('a log that could not be read says so, and offers a retry', () => {
  const markup = render({
    logExpanded: true,
    log: { ...emptyLog(), error: new Error('the runtime refused the read') },
  });

  // The failure a person must not be told is "nothing recorded yet": an unreadable history and an
  // empty one are different facts about the run, and only one of them is the run's own doing.
  assert.match(markup, new RegExp(escape(workflowCopy.logReadFailed)));
  assert.match(markup, new RegExp(escape(workflowCopy.logRetry)));
  assert.doesNotMatch(markup, new RegExp(escape(workflowCopy.logEmpty)));
  // And it is not the runtime's raw sentence.
  assert.doesNotMatch(markup, /refused the read/);
});

test('a stored detail offers to be loaded rather than stating only that it is large', () => {
  const markup = render({
    logExpanded: true,
    log: {
      ...emptyLog(),
      lines: [
        {
          revision: 4,
          recordedAt: '2026-09-15T10:00:04.000Z',
          tone: 'info',
          label: 'log',
          body: workflowCopy.logDetailStored,
          diagnostic: null,
          storedDetail: { payloadRef: 'sha256:big', byteSize: 20_000 },
        },
      ],
    },
  });

  assert.match(markup, new RegExp(escape(workflowCopy.logDetailStored)));
  assert.match(markup, new RegExp(escape(workflowCopy.logDetailLoad)));
});

test('while an action is in flight every control waits, not only the one that was pressed', () => {
  const markup = render({ actionsLocked: true });
  // Issuing two run-level controls at once means nothing — the runtime fences them on control
  // revision — and leaving the rest live let a fast action clear the indicator while a slower one
  // was still outstanding, so every button looked idle with work still in flight.
  const buttons = markup.match(/<button[^>]*aria-label="(Pause|Cancel)"[^>]*>/g) ?? [];
  assert.equal(buttons.length, 2);
  assert.ok(
    buttons.every((button) => button.includes('disabled')),
    'every offered control should be waiting',
  );
});

test('an action failure is announced without removing the run from the bar', () => {
  const markup = render({ actionError: "Couldn't pause the workflow. This workflow moved on." });
  assert.match(markup, /Couldn&#x27;t pause the workflow\./);
  // The bar is still the run's bar: a refused control is not a reason to lose the attachment.
  assert.match(markup, /aria-label="Workflow"/);
});

function controls(): WorkflowRunSummary['controls'] {
  return workflowSummaryFixture().controls;
}

function emptyLog(): WorkflowLogView {
  return {
    runId: 1,
    lines: [],
    isLoading: false,
    error: null,
    hasOlder: false,
    loadEarlier: () => {},
    retry: () => {},
  };
}

function render(overrides: Partial<WorkflowBarProps> = {}): string {
  const props: WorkflowBarProps = {
    summary: workflowSummaryFixture(),
    log: emptyLog(),
    connection: 'connected',
    logExpanded: false,
    inspectorOpen: false,
    actionsLocked: false,
    actionError: null,
    onToggleLog: () => {},
    onToggleInspector: () => {},
    onPause: () => {},
    onResume: () => {},
    onCancel: () => {},
    onRetry: () => {},
    onDismiss: () => {},
    onAdvance: () => {},
    ...overrides,
  };
  // A log line may ask for a stored detail, which is a query. The provider is the component's real
  // environment, not a concession to the test.
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <WorkflowBar {...props} />
    </QueryClientProvider>,
  );
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '&#x27;');
}
