import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import type { WorkflowOperationDto } from '@isagi/contracts';

import {
  workflowEvidenceFixture,
  workflowOperationFixture,
} from '../../../lib/workspace/workflow/test-support.js';
import { inspectorCopy } from './copy.js';
import { evidenceDataTabs, evidenceTabKey } from './dock.js';
import { buildEvidenceTree } from './evidence-view.js';
import { clockAt, nested, rootFrame, runStateFixture, visit } from './test-support.js';
import { buildTraceModel } from './trace.js';
import { WorkflowEvidenceContent } from './WorkflowContentViewer.js';
import { WorkflowEvidenceCard } from './WorkflowEvidenceCard.js';
import { WorkflowEvidenceDetail } from './WorkflowEvidenceDetail.js';
import { WorkflowEvidenceTree } from './WorkflowEvidenceTree.js';
import { WorkflowOperationProvenance } from './WorkflowOperationProvenance.js';
import { WorkflowTraceWaterfall } from './WorkflowTraceWaterfall.js';

/**
 * What the evidence surfaces say, given facts.
 *
 * Markup only. Everything that needs a click — opening a card as a Data tab, the HTML source /
 * render toggle, a download, the two surfaces resolving to one cache entry — lives in the browser
 * suite, because this one renders to a string and has no DOM to click.
 *
 * The rules under test are the honest ones: that no unknown renders as a blank cell, that a weak
 * attribution is never dressed as a strong one, and that bytes Isagi cannot read never take the
 * record's own metadata down with them.
 */

function render(node: React.ReactNode): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
  // A string render never unmounts, so the cache entries these components create would sit on
  // their garbage-collection timers and hold the test process open for five minutes.
  client.clear();
  return markup;
}

/** Copy as it lands in markup. React escapes quotes, so a raw string would silently never match. */
function asRendered(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

function operation(overrides: Partial<WorkflowOperationDto> = {}): WorkflowOperationDto {
  return workflowOperationFixture(overrides);
}

const unknownProvenance = {
  harness: null,
  model: null,
  effort: null,
  harnessSessionId: null,
  attribution: 'not_applicable',
  cwd: null,
  runtime: null,
  usage: null,
  artifactHash: 'sha256:pin-1',
} as const;

test('a wholly unknown provenance says so in words, never in blanks', () => {
  const markup = render(
    <WorkflowOperationProvenance
      operation={operation({ capability: 'run_headless_agent', provenance: unknownProvenance })}
    />,
  );

  // Ten labels, ten values. A field that rendered empty would be indistinguishable from a field
  // nobody bothered to project.
  for (const label of [
    'harness',
    'model',
    'effort',
    'native session',
    'attribution',
    'cwd',
    'runtime',
    'transcript',
    'usage',
    'code pin',
  ]) {
    assert.ok(markup.includes(`>${label}</dt>`), `${label} is missing`);
  }
  assert.equal(markup.includes('<dd class="m-0 wrap-break-word text-fg-subtle"></dd>'), false);

  // Each unknown names its own reason rather than all of them saying "unknown".
  assert.ok(markup.includes(inspectorCopy.provenanceSessionUncorrelated));
  assert.ok(markup.includes(inspectorCopy.provenanceTranscriptNotChecked));
  assert.ok(markup.includes('not applicable'));
});

test("a send's null model is inherited from the session; another capability's is simply unknown", () => {
  const sent = render(
    <WorkflowOperationProvenance
      operation={operation({ capability: 'send_agent_prompt', provenance: unknownProvenance })}
    />,
  );
  assert.ok(sent.includes(inspectorCopy.provenanceModelInherited));

  const headless = render(
    <WorkflowOperationProvenance
      operation={operation({ capability: 'run_headless_agent', provenance: unknownProvenance })}
    />,
  );
  assert.equal(headless.includes(inspectorCopy.provenanceModelInherited), false);
});

test('usage shows all five reported figures and computes no total', () => {
  const markup = render(
    <WorkflowOperationProvenance
      operation={operation({
        capability: 'run_headless_agent',
        provenance: {
          ...unknownProvenance,
          usage: {
            inputTokens: 2,
            cacheReadInputTokens: 10_118,
            cacheCreationInputTokens: 10_019,
            outputTokens: 1204,
            costUsd: 0.0731,
          },
        },
      })}
    />,
  );

  assert.ok(markup.includes('in 2 '));
  assert.ok(markup.includes('cache read 10,118'));
  assert.ok(markup.includes('cache write 10,019'));
  assert.ok(markup.includes('out 1,204'));
  assert.ok(markup.includes('cost $0.0731'));
  // The sum of the three input counts is a number this run never reported. Nothing renders it.
  assert.equal(markup.includes('20,139'), false);
  assert.equal(markup.includes('21,343'), false);
});

test('a transcript that was looked for and is gone keeps its path, and is not dressed as available', () => {
  const rotated = render(
    <WorkflowOperationProvenance
      operation={operation({
        provenance: {
          ...unknownProvenance,
          transcript: { locator: '~/.claude/projects/x/8b4e.jsonl', available: false },
        },
      })}
    />,
  );
  assert.ok(rotated.includes(inspectorCopy.provenanceTranscriptUnavailable));
  assert.ok(rotated.includes('~/.claude/projects/x/8b4e.jsonl'));
  assert.ok(rotated.includes('text-amber'));

  const absent = render(
    <WorkflowOperationProvenance
      operation={operation({ provenance: { ...unknownProvenance, transcript: null } })}
    />,
  );
  assert.ok(absent.includes(inspectorCopy.provenanceTranscriptNoLocator));
});

test('an exact attribution reads differently from an inferred or unresolved one', () => {
  const exact = render(
    <WorkflowEvidenceCard
      record={workflowEvidenceFixture({
        source: {
          kind: 'agent_turn',
          agentSessionId: 41,
          operationKey: 'wop_1',
          attribution: 'exact',
        },
      })}
      selected={false}
      onSelect={() => undefined}
    />,
  );
  assert.ok(exact.includes('text-green'));

  for (const attribution of ['inferred_latest_operation', 'unresolved'] as const) {
    const weak = render(
      <WorkflowEvidenceCard
        record={workflowEvidenceFixture({
          source: {
            kind: 'agent_session',
            agentSessionId: 43,
            operationKey: null,
            attribution,
          },
        })}
        selected={false}
        onSelect={() => undefined}
      />,
    );
    assert.equal(weak.includes('text-green'), false, `${attribution} must not read as exact`);
    assert.ok(weak.includes('text-amber'));
  }
});

test('an unresolved source says no operation matched, instead of leaving the line blank', () => {
  const markup = render(
    <WorkflowEvidenceDetail
      runId={1}
      record={workflowEvidenceFixture({
        source: {
          kind: 'agent_turn',
          agentSessionId: 41,
          operationKey: null,
          attribution: 'unresolved',
        },
      })}
    />,
  );
  assert.ok(markup.includes(inspectorCopy.evidenceSourceUnresolvedOperation));

  const none = render(<WorkflowEvidenceDetail runId={1} record={workflowEvidenceFixture({})} />);
  assert.ok(none.includes(inspectorCopy.evidenceSourceNoneNote));
});

test('a file capture says the bytes are a moment, not a window onto the path', () => {
  const markup = render(
    <WorkflowEvidenceDetail
      runId={1}
      record={workflowEvidenceFixture({
        content: {
          kind: 'file',
          mediaType: 'text/markdown',
          byteSize: 14_200,
          contentRef: 'sha256:bbbb',
          sourcePath: 'docs/plan.md',
        },
      })}
    />,
  );
  assert.ok(markup.includes('docs/plan.md'));
  assert.ok(markup.includes('bytes as they were at'));
});

test('a media type Isagi cannot preview offers the file and says why, without pretending to fetch', () => {
  const markup = render(
    <WorkflowEvidenceContent
      runId={1}
      record={workflowEvidenceFixture({
        content: {
          kind: 'file',
          mediaType: 'application/gzip',
          byteSize: 1_400_000,
          contentRef: 'sha256:cccc',
          sourcePath: '.isagi/verify-logs.tar.gz',
        },
      })}
    />,
  );
  assert.ok(markup.includes(asRendered(inspectorCopy.evidenceDownloadOnly('application/gzip'))));
  assert.ok(markup.includes(inspectorCopy.evidenceDownload));
  assert.equal(markup.includes(inspectorCopy.evidenceContentLoading), false);
});

test('a previewable record over the cap waits to be asked, and states its size', () => {
  const markup = render(
    <WorkflowEvidenceContent
      runId={1}
      record={workflowEvidenceFixture({
        content: {
          kind: 'text',
          mediaType: 'text/markdown',
          byteSize: 9_000_000,
          contentRef: 'sha256:dddd',
          sourcePath: null,
        },
      })}
    />,
  );
  // Arrow-keying a tree must not pull nine megabytes per row. It asks first, exactly as a stored
  // payload does one pane over.
  assert.ok(markup.includes(inspectorCopy.evidenceContentLoad));
  assert.ok(markup.includes('8.6 MB'));
});

test('a tree row and a dock card describe one record identically', () => {
  const record = workflowEvidenceFixture({
    role: 'review-feedback',
    labels: { round: 2 },
    content: {
      kind: 'text',
      mediaType: 'text/markdown',
      byteSize: 5_324,
      contentRef: 'sha256:eeee',
      sourcePath: null,
    },
  });
  const card = render(
    <WorkflowEvidenceCard record={record} selected={false} onSelect={() => undefined} />,
  );
  const state = runStateFixture({ executions: [visit({ executionId: 1 })] });
  const row = render(
    <WorkflowEvidenceTree
      tree={buildEvidenceTree({
        state,
        records: [record],
        rootExecutionId: null,
        liveExecutionId: null,
      })}
      selectedKey={null}
      onSelect={() => undefined}
    />,
  );
  for (const fragment of ['review-feedback', 'round:', '>2<', 'markdown', '5.2 KB']) {
    assert.ok(card.includes(fragment), `card is missing ${fragment}`);
    assert.ok(row.includes(fragment), `row is missing ${fragment}`);
  }
});

test('a subgraph group counts its whole subtree, spelled the way its trace row spells it', () => {
  const state = runStateFixture({
    frames: [
      rootFrame(),
      nested({ frameId: 2, parentExecutionId: 2, parentFrameId: 1, graphKey: 'phase', depth: 1 }),
    ],
    executions: [
      visit({ executionId: 2, frameId: 1, nodeId: 'phase', nodeKind: 'subgraph', childFrameId: 2 }),
      visit({ executionId: 3, frameId: 2, nodeId: 'review' }),
    ],
  });
  const markup = render(
    <WorkflowEvidenceTree
      tree={buildEvidenceTree({
        state,
        records: [
          workflowEvidenceFixture({ evidenceKey: 'a', executionId: 3 }),
          workflowEvidenceFixture({ evidenceKey: 'b', executionId: 3 }),
        ],
        rootExecutionId: null,
        liveExecutionId: null,
      })}
      selectedKey={null}
      onSelect={() => undefined}
    />,
  );
  assert.ok(markup.includes(inspectorCopy.evidenceInside(2)));
});

test('a live visit with nothing captured renders its line, not an empty heading', () => {
  const state = runStateFixture({ executions: [visit({ executionId: 1, nodeId: 'implement' })] });
  const markup = render(
    <WorkflowEvidenceTree
      tree={buildEvidenceTree({
        state,
        records: [],
        rootExecutionId: null,
        liveExecutionId: 1,
      })}
      selectedKey={null}
      onSelect={() => undefined}
    />,
  );
  assert.ok(markup.includes(inspectorCopy.evidenceGroupEmpty));
});

test('a Data tab is named by its position in the column and keyed by the record', () => {
  const tabs = evidenceDataTabs([
    workflowEvidenceFixture({ evidenceKey: 'wev_a' }),
    workflowEvidenceFixture({ evidenceKey: 'wev_b' }),
  ]);
  assert.deepEqual(
    tabs.map((tab) => tab.name),
    ['ev1 · content', 'ev2 · content'],
  );
  // Keyed by the record, so the tab follows the thing rather than the ordinal it happened to have.
  assert.equal(tabs[1]?.key, evidenceTabKey('wev_b'));
  assert.equal(tabs[0]?.kind, 'evidence');
});

test('a trace row shows what it kept, and a row that kept nothing carries no badge', () => {
  const state = runStateFixture({
    frames: [
      rootFrame(),
      nested({ frameId: 2, parentExecutionId: 2, parentFrameId: 1, graphKey: 'phase', depth: 1 }),
    ],
    executions: [
      visit({ executionId: 1, frameId: 1, nodeId: 'discover' }),
      visit({
        executionId: 2,
        frameId: 1,
        nodeId: 'phase',
        nodeKind: 'subgraph',
        childFrameId: 2,
        operationSummary: { count: 0, unresolved: 0, evidenceCaptured: 7, capabilities: [] },
      }),
      visit({
        executionId: 3,
        frameId: 2,
        nodeId: 'review',
        operationSummary: { count: 1, unresolved: 0, evidenceCaptured: 3, capabilities: [] },
      }),
    ],
  });
  const markup = render(
    <WorkflowTraceWaterfall
      model={buildTraceModel({ state, collapsed: new Set() })}
      now={clockAt(120)}
      selection={null}
      liveExecutionId={null}
      onSelect={() => undefined}
      onToggleExpanded={() => undefined}
    />,
  );

  // The subgraph's number covers its whole child frame, so it is spelled as a containment rather
  // than as a count that could be added to the nested row's own.
  assert.ok(markup.includes(inspectorCopy.evidenceInside(7)));
  assert.ok(markup.includes('>3</span>'));
  // `discover` captured nothing. A badge reading zero would be a fact nobody needs on every row.
  assert.equal(markup.includes(inspectorCopy.evidenceInside(0)), false);
  assert.equal((markup.match(/border-cyan\/35/g) ?? []).length, 2);
});
