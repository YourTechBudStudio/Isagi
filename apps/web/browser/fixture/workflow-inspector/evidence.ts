import type { WorkflowEvidenceDto, WorkflowExecutionDto, WorkflowFrameDto } from '@isagi/contracts';

/**
 * What the fixture run captured, and the bytes behind it.
 *
 * Every content state the viewer has to tell apart is represented once: text, JSON, an image, HTML
 * with its opt-in render, a media type nothing previews, a text record over the preview cap, and a
 * record whose bytes the store cannot serve. The last one matters most — its card looks exactly
 * like every other card until it is opened, which is the arrangement the design chose and the one
 * a test has to be able to observe.
 *
 * Attribution is spread across all four answers for the same reason: `exact` must not be reachable
 * by accident, and `unresolved` has to be visibly different from a record whose author named no
 * source at all.
 */

const pin = 'sha256:9f2c1abfixture';

/** The visit that owns each record, and the order they were captured in. */
export const EVIDENCE_EXECUTION = 102;
export const EVIDENCE_NESTED_EXECUTION = 104;

const html =
  '<!doctype html>\n<html>\n<head><title>Coverage</title>\n<link rel="stylesheet" href="./prettify.css"></head>\n<body>\n<h1>Coverage · workflows/persistence</h1>\n<table><tr><th>File</th><th>Stmts</th></tr><tr><td>content-store.ts</td><td>96.2%</td></tr></table>\n</body>\n</html>';

/** A 1×1 PNG. Small enough to inline, real enough that a browser decodes it. */
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Just over 256 KiB, so the preview truncates and says so. */
const longText = `# Implementer response\n\n${'The content store split is done. '.repeat(9000)}`;

export type EvidenceBytes =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'base64'; readonly base64: string }
  | { readonly kind: 'unavailable'; readonly cause: 'missing' | 'corrupt' };

interface Fixture {
  readonly record: WorkflowEvidenceDto;
  readonly bytes: EvidenceBytes;
}

function evidence(
  overrides: Partial<WorkflowEvidenceDto> & Pick<WorkflowEvidenceDto, 'evidenceKey' | 'title'>,
): WorkflowEvidenceDto {
  return {
    frameId: 1,
    executionId: EVIDENCE_EXECUTION,
    attemptId: 1,
    operationKey: 'op-triage-0',
    role: 'note',
    labels: {},
    content: {
      kind: 'text',
      mediaType: 'text/markdown',
      byteSize: 120,
      contentRef: 'sha256:4b1fe2c7',
      sourcePath: null,
    },
    source: { kind: 'none' },
    artifactHash: pin,
    capturedAt: new Date(Date.now() - 120_000).toISOString(),
    ...overrides,
  };
}

const fixtures: readonly Fixture[] = [
  {
    record: evidence({
      evidenceKey: 'wev_plan',
      title: 'Plan',
      role: 'plan',
      labels: { phase: 2, round: 1 },
      operationKey: 'op-triage-0',
      content: {
        kind: 'file',
        mediaType: 'text/markdown',
        byteSize: 148,
        contentRef: 'sha256:4b1fe2c7',
        sourcePath: 'docs/plan.md',
      },
      source: {
        kind: 'agent_turn',
        agentSessionId: 7,
        operationKey: 'op-triage-0',
        attribution: 'exact',
      },
    }),
    bytes: {
      kind: 'text',
      text: '# Plan — evidence capture\n\n## Phase 1: content store\n- streamed put, verified open\n\n## Phase 2: capture verb\n- positional identity, bytes excluded\n',
    },
  },
  {
    record: evidence({
      evidenceKey: 'wev_verify',
      title: 'Verification result',
      role: 'verification',
      labels: { phase: 2 },
      operationKey: 'op-triage-1',
      content: {
        kind: 'json',
        mediaType: 'application/json',
        byteSize: 96,
        contentRef: 'sha256:7c1ea9d2',
        sourcePath: null,
      },
      source: {
        kind: 'headless_operation',
        agentSessionId: null,
        operationKey: 'op-triage-1',
        attribution: 'exact',
      },
    }),
    bytes: { kind: 'text', text: '{"command":"pnpm check","exitCode":0,"warnings":0}' },
  },
  {
    record: evidence({
      evidenceKey: 'wev_shot',
      title: 'Failing test, before fix',
      role: 'screenshot',
      labels: { round: 1 },
      content: {
        kind: 'bytes',
        mediaType: 'image/png',
        byteSize: 70,
        contentRef: 'sha256:b1c47c20',
        sourcePath: null,
      },
      source: {
        kind: 'agent_session',
        agentSessionId: 7,
        operationKey: 'op-triage-0',
        attribution: 'inferred_latest_operation',
      },
    }),
    bytes: { kind: 'base64', base64: pngBase64 },
  },
  {
    record: evidence({
      evidenceKey: 'wev_coverage',
      title: 'Coverage report',
      role: 'verification',
      content: {
        kind: 'file',
        mediaType: 'text/html',
        byteSize: html.length,
        contentRef: 'sha256:9e115d9f',
        sourcePath: 'coverage/index.html',
      },
    }),
    bytes: { kind: 'text', text: html },
  },
  {
    record: evidence({
      evidenceKey: 'wev_logs',
      title: 'Verification logs',
      role: 'verification',
      content: {
        kind: 'file',
        mediaType: 'application/gzip',
        byteSize: 1_400_000,
        contentRef: 'sha256:9e120aa3',
        sourcePath: '.isagi/verify-logs.tar.gz',
      },
    }),
    bytes: { kind: 'text', text: 'not really gzip, and nothing previews it anyway' },
  },
  {
    record: evidence({
      evidenceKey: 'wev_long',
      title: 'Implementer response',
      role: 'implementer-response',
      labels: { round: 2 },
      content: {
        kind: 'text',
        mediaType: 'text/markdown',
        byteSize: longText.length,
        contentRef: 'sha256:2b409e11',
        sourcePath: null,
      },
      source: {
        kind: 'agent_turn',
        agentSessionId: 7,
        operationKey: null,
        attribution: 'unresolved',
      },
    }),
    bytes: { kind: 'text', text: longText },
  },
  {
    record: evidence({
      evidenceKey: 'wev_gone',
      title: 'Decision log',
      role: 'decision-log',
      content: {
        kind: 'file',
        mediaType: 'text/markdown',
        byteSize: 6_100,
        contentRef: 'sha256:2c9af014',
        sourcePath: 'docs/decision-log.md',
      },
    }),
    // Indistinguishable from the others in the column. That is the point.
    bytes: { kind: 'unavailable', cause: 'corrupt' },
  },
  {
    record: evidence({
      evidenceKey: 'wev_nested',
      title: 'Review round 1',
      role: 'review-feedback',
      labels: { round: 1 },
      frameId: 2,
      executionId: EVIDENCE_NESTED_EXECUTION,
      operationKey: 'op-read-0',
      content: {
        kind: 'text',
        mediaType: 'text/markdown',
        byteSize: 64,
        contentRef: 'sha256:8d0277f0',
        sourcePath: null,
      },
    }),
    bytes: { kind: 'text', text: '## Review — round 1\n\nTwo blocking issues.\n' },
  },
];

export const evidenceRecords: readonly WorkflowEvidenceDto[] = fixtures.map(
  (fixture) => fixture.record,
);

export const evidenceBytes: ReadonlyMap<string, EvidenceBytes> = new Map(
  fixtures.map((fixture) => [fixture.record.evidenceKey, fixture.bytes]),
);

/**
 * Stamp `evidenceCaptured` onto the executions these records belong to, **subtree-inclusively**.
 *
 * Computed here rather than written by hand so the fixture cannot drift from the rule the client
 * depends on: a visit's number already counts everything beneath its child frame. A hand-written
 * number that disagreed with the listing would make the dock and the panel look inconsistent for a
 * reason that had nothing to do with the code under test.
 */
export function withEvidenceCounts(
  executions: readonly WorkflowExecutionDto[],
  frames: readonly WorkflowFrameDto[],
): readonly WorkflowExecutionDto[] {
  const direct = new Map<number, number>();
  for (const fixture of fixtures) {
    const { executionId } = fixture.record;
    direct.set(executionId, (direct.get(executionId) ?? 0) + 1);
  }

  const frameOwner = new Map(frames.map((frame) => [frame.frameId, frame.parentExecutionId]));
  const executionFrame = new Map(executions.map((row) => [row.executionId, row.frameId]));
  const total = new Map(direct);
  for (const [executionId, count] of direct) {
    let frameId = executionFrame.get(executionId) ?? null;
    for (let hops = 0; frameId !== null && hops < 32; hops += 1) {
      const owner = frameOwner.get(frameId) ?? null;
      if (owner === null) break;
      total.set(owner, (total.get(owner) ?? 0) + count);
      frameId = executionFrame.get(owner) ?? null;
    }
  }

  return executions.map((row) =>
    total.has(row.executionId)
      ? {
          ...row,
          operationSummary: {
            ...row.operationSummary,
            evidenceCaptured: total.get(row.executionId)!,
          },
        }
      : row,
  );
}

/** The listing the route answers, scoped the way the real one is. */
export function listEvidence(query: URLSearchParams): {
  readonly items: readonly WorkflowEvidenceDto[];
} {
  const executionId = query.get('executionId');
  if (executionId === null) return { items: evidenceRecords };
  const target = Number(executionId);
  const subtree = query.get('subtree') === 'true';
  return {
    items: evidenceRecords.filter((item) =>
      item.executionId === target
        ? true
        : // The nested record is inside the first-pass subgraph, which is the only containment the
          // fixture has. Good enough to prove a subtree listing is not the visit's own listing.
          subtree && target === 103 && item.executionId === EVIDENCE_NESTED_EXECUTION,
    ),
  };
}
