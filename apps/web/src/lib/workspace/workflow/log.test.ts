import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowCopy, workflowDiagnosticCodeCopy } from '../../../copy/index.js';
import { isDiagnosticTransition, workflowLogLine, workflowLogLineFromPayload } from './log.js';
import { workflowDeltaFixture } from './test-support.js';

test('only diagnostics are activity; structural transitions are not log lines', () => {
  assert.equal(isDiagnosticTransition(workflowDeltaFixture({ revision: 1 })), false);
  assert.equal(workflowLogLine(workflowDeltaFixture({ revision: 1 })), null);
  assert.equal(
    isDiagnosticTransition(diagnostic(1, { source: 'author_log', level: 'info', message: 'x' })),
    true,
  );
});

test("an author's own line is shown as written", () => {
  const line = workflowLogLine(
    diagnostic(2, { source: 'author_log', level: 'warning', message: 'Draft looked thin.' }),
  );
  assert.equal(line?.body, 'Draft looked thin.');
  assert.equal(line?.tone, 'warning');
  assert.equal(line?.diagnostic, null);
});

test('author feedback falls back to its phase when it carries no message', () => {
  const withMessage = workflowLogLine(
    diagnostic(3, { source: 'ui_feedback', kind: 'info', phase: 'writing', message: 'Drafting' }),
  );
  assert.equal(withMessage?.body, 'Drafting');
  assert.equal(withMessage?.label, 'feedback');

  const phaseOnly = workflowLogLine(
    diagnostic(4, { source: 'ui_feedback', kind: 'error', phase: 'writing' }),
  );
  assert.equal(phaseOnly?.body, 'writing');
  assert.equal(phaseOnly?.tone, 'error');
});

test("a runtime diagnostic reads as Isagi's sentence, with the runtime's text kept beside it", () => {
  const line = workflowLogLine(
    diagnostic(5, {
      source: 'runtime_diagnostic',
      code: 'label_failed',
      level: 'warning',
      message: "The display name for node 'writer' was not captured because it threw.",
    }),
  );
  assert.equal(line?.body, workflowDiagnosticCodeCopy('label_failed'));
  // The raw text survives for a bug report, but it is never the voiced line.
  assert.match(line?.diagnostic ?? '', /was not captured/);
  assert.notEqual(line?.body, line?.diagnostic);
});

test('an unrecognised detail says so instead of rendering guessed fields', () => {
  // The pre-contract shape: plausible, and deliberately not accepted.
  const legacy = workflowLogLine(diagnostic(6, { level: 'info', message: 'legacy line' }));
  assert.equal(legacy?.body, workflowCopy.logDetailUnreadable);
  assert.equal(legacy?.tone, 'warning');

  const empty = workflowLogLine(
    workflowDeltaFixture({ revision: 7, transition: { kind: 'log', detailRef: null } }),
  );
  assert.equal(empty?.body, workflowCopy.logDetailUnreadable);
});

test('a stored detail is announced with its size and never fetched on its own', () => {
  const line = workflowLogLine(
    workflowDeltaFixture({
      revision: 8,
      transition: {
        kind: 'log',
        detailRef: { payloadRef: 'sha256:big', byteSize: 20_000, mediaType: 'application/json' },
      },
    }),
  );
  assert.equal(line?.body, workflowCopy.logDetailStored);
  assert.deepEqual(line?.storedDetail, { payloadRef: 'sha256:big', byteSize: 20_000 });

  // Once the person asks for it, it reads exactly like an inline entry would have.
  const loaded = workflowLogLineFromPayload(line!, {
    source: 'author_log',
    level: 'error',
    message: 'a very long line',
  });
  assert.equal(loaded.body, 'a very long line');
  assert.equal(loaded.tone, 'error');
  assert.equal(loaded.storedDetail, null);
  assert.equal(loaded.revision, 8);
});

/** The transition kind follows the detail's source, exactly as the runtime writes them. */
function diagnostic(revision: number, detail: unknown) {
  const source =
    detail && typeof detail === 'object' && 'source' in detail
      ? (detail as { readonly source: unknown }).source
      : null;
  return workflowDeltaFixture({
    revision,
    transition: {
      kind: source === 'ui_feedback' ? 'ui_feedback' : 'log',
      detailRef: { inline: detail },
    },
  });
}
