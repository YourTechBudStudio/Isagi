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
 * summary — which controls exist, what a failure says, and when the bar asks the person something.
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
      status: 'completed',
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
  assert.match(workflowCopy.cancelConfirmDetail, /keeps everything recorded so far/);
  assert.match(workflowCopy.cancelConfirmDetail, /agent panes stay open/);
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
        output: null,
      },
      controls: { ...controls(), pause: false, cancel: false, dismiss: true },
    }),
  });

  assert.match(markup, /The reviewer rejected the draft\./);
  assert.doesNotMatch(markup, /aria-label="Retry"/);
});

test('a step failure shows Isagi’s sentence and keeps the runtime’s own text as diagnostic', () => {
  const markup = render({
    summary: workflowSummaryFixture({
      status: 'failed',
      error: {
        stage: 'node_function',
        message: 'TypeError: cannot read property draft of undefined',
        graphKey: 'root',
        nodeId: 'plan',
      },
      controls: { ...controls(), pause: false, cancel: false, retry: true, dismiss: true },
    }),
  });

  assert.match(markup, /A step in this workflow threw\./);
  assert.match(markup, /node_function root\/plan/);
  assert.match(markup, /cannot read property draft of undefined/);
  assert.match(markup, /aria-label="Retry"/);
});

test('a paused run with a pending question says the answer will not restart it', () => {
  const markup = render({
    summary: workflowSummaryFixture({
      status: 'paused',
      current: parked({ kind: 'user_continue', label: 'Ready for review?' }),
      controls: { ...controls(), pause: false, resume: true },
    }),
  });

  assert.match(markup, /Ready for review\?/);
  assert.match(markup, new RegExp(escape(workflowCopy.continuePrompt)));
  assert.match(markup, new RegExp(escape(workflowCopy.pausedAnswerNote)));
});

test('a run that is not waiting or paused takes no answer, even with a user wait recorded', () => {
  const markup = render({
    summary: workflowSummaryFixture({
      status: 'failed',
      current: parked({ kind: 'user_continue' }),
    }),
  });
  assert.doesNotMatch(markup, new RegExp(escape(workflowCopy.continuePrompt)));
});

test('an agent turn is the run waiting on a machine, so the bar asks nothing', () => {
  const markup = render({
    summary: workflowSummaryFixture({
      status: 'waiting',
      current: parked({ kind: 'agent_turn', target: { agentSessionId: 1, sentAt: 'x' } }),
    }),
  });
  assert.doesNotMatch(markup, new RegExp(escape(workflowCopy.continuePrompt)));
  assert.match(markup, /Driving/);
});

test('the log shows the run’s log lines', () => {
  const markup = render({
    logExpanded: true,
    log: {
      ...emptyLog(),
      lines: [
        {
          eventId: 12,
          at: '2026-09-15T10:00:12.000Z',
          tone: 'info',
          label: 'log',
          body: 'Drafting the summary.',
        },
      ],
    },
  });
  assert.match(markup, /Drafting the summary\./);
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

test('while an action is in flight every control waits, not only the one that was pressed', () => {
  const markup = render({ actionsLocked: true });
  // Issuing two run-level controls at once means nothing, and leaving the rest live let a fast
  // action clear the indicator while a slower one was still outstanding.
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
  // The provider is the component's real environment, not a concession to the test.
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <WorkflowBar {...props} />
    </QueryClientProvider>,
  );
}

function parked(
  wait: NonNullable<WorkflowRunSummary['current']>['wait'],
): WorkflowRunSummary['current'] {
  return {
    executionId: 2,
    invocationId: 1,
    graphKey: 'root',
    nodeId: 'ask',
    nodeKind: 'operation',
    label: null,
    wait,
  };
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '&#x27;');
}
