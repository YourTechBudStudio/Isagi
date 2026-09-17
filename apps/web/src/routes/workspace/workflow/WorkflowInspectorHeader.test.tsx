import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { WorkflowRunSummary } from '@isagi/contracts';

import { workflowCopy } from '../../../copy/index.js';
import { workflowSummaryFixture } from '../../../lib/workspace/workflow/test-support.js';
import { inspectorCopy } from './copy.js';
import { WorkflowInspectorHeader } from './WorkflowInspectorHeader.js';

/**
 * What the header says about where a run was placed.
 *
 * The line exists to answer "who decided this, and what did they decide", from the run's own
 * retained record. It must be absent when nobody decided anything, must never name a resource the
 * summary does not carry, and must not displace the facts or the reason line it sits between.
 */

function render(summary: WorkflowRunSummary): string {
  return renderToStaticMarkup(
    <WorkflowInspectorHeader
      summary={summary}
      now={Date.parse('2026-09-15T10:05:00.000Z')}
      closeRef={null}
      onClose={() => {}}
    />,
  );
}

/**
 * The placement line's own text.
 *
 * Read as its own paragraph rather than searched for across the whole header, so an assertion about
 * what this line does not say cannot be satisfied — or broken — by the two lines around it.
 */
function placementLine(markup: string): string | null {
  const paragraphs = [...markup.matchAll(/<p[^>]*>(.*?)<\/p>/g)].map((match) => match[1] ?? '');
  const line = paragraphs.find(
    (paragraph) =>
      paragraph.includes(inspectorCopy.placementBySelector) ||
      paragraph.includes(inspectorCopy.placementByOverride),
  );
  return line === undefined ? null : plainText(line);
}

/** Rendered markup as a person reads it: no tags, and entities back to the characters they encode. */
function plainText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, '')
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

function placed(preparation: Partial<WorkflowRunSummary['preparation']>): WorkflowRunSummary {
  const base = workflowSummaryFixture();
  return workflowSummaryFixture({ preparation: { ...base.preparation, ...preparation } });
}

test('a default placement adds nothing, so the common case is untouched', () => {
  const markup = render(workflowSummaryFixture());

  assert.doesNotMatch(markup, new RegExp(inspectorCopy.placementBySelector));
  assert.doesNotMatch(markup, new RegExp(inspectorCopy.placementByOverride));
  assert.doesNotMatch(markup, /current worktree/);
});

test('a run the workflow placed says so, and names the worktree it created', () => {
  const markup = render(
    placed({
      source: 'selector',
      request: {
        worktree: { kind: 'create', branch: 'feat/story-44', fromRef: 'main' },
        surface: { kind: 'create', title: 'Implement story #44' },
      },
      baseCommit: '9f3e1c2a4b5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f',
      surface: {
        surfaceId: 9,
        requestedTitle: 'Implement story #44',
        title: 'Implement story #44',
        recordedAt: '2026-09-15T10:00:00.000Z',
      },
    }),
  );

  assert.match(markup, new RegExp(inspectorCopy.placementBySelector));
  assert.match(markup, /new worktree feat\/story-44 from main @ 9f3e1c2/);
  assert.match(markup, /new surface &quot;Implement story #44&quot;/);
});

test('a caller override says so, and reuse is named by what the request asked for', () => {
  const markup = render(
    placed({
      source: 'override',
      request: {
        worktree: { kind: 'existing', worktreeId: 10 },
        surface: { kind: 'existing', surfaceId: 101 },
      },
    }),
  );

  assert.match(markup, new RegExp(inspectorCopy.placementByOverride));
  // The folder comes from the destination the commit wrote, not from a live worktree row.
  assert.match(placementLine(markup) ?? '', /existing worktree/);
  // No title: the summary carries none for a surface this launch did not create, and inventing one
  // from live workspace state would put a deletable fact in a line of retained history.
  const line = placementLine(markup) ?? '';
  assert.match(line, /existing surface/);
  assert.doesNotMatch(line, /existing surface "/);
});

test('an override that kept the current environment still says who decided that', () => {
  const markup = render(
    placed({
      source: 'override',
      request: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
    }),
  );

  assert.match(markup, /current worktree/);
  assert.match(markup, /current surface/);
});

test('a created worktree with no resolved base commit is named without one', () => {
  const markup = render(
    placed({
      source: 'selector',
      request: {
        worktree: { kind: 'create', branch: 'feat/x', fromRef: 'main' },
        surface: { kind: 'current' },
      },
      baseCommit: null,
    }),
  );

  const line = placementLine(markup) ?? '';
  assert.match(line, /new worktree feat\/x from main/);
  // No commit was resolved, so none is claimed.
  assert.doesNotMatch(line, /@/);
});

test('the placement line coexists with the reason line when the worktree was later deleted', () => {
  const base = workflowSummaryFixture();
  const markup = render(
    workflowSummaryFixture({
      destination: { ...base.destination, available: false },
      preparation: {
        ...base.preparation,
        source: 'selector',
        request: {
          worktree: { kind: 'create', branch: 'feat/story-44', fromRef: 'main' },
          surface: { kind: 'create', title: 'Implement story #44' },
        },
        baseCommit: '9f3e1c2a4b5d',
      },
    }),
  );

  // What was created is still a true statement about this run, even once it is gone, and it sits
  // beside the reason line rather than replacing it.
  assert.match(placementLine(markup) ?? '', /new worktree feat\/story-44/);
  assert.ok(plainText(markup).includes(workflowCopy.environmentUnavailable));
  assert.match(markup, /holding/);
});
