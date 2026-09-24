import type { ListWorkflowEvidenceQuery, WorkflowEvidenceDto } from '@isagi/contracts';

import { makeEngineHarness, type EngineHarness } from '../engine/test-support.js';
import { headlessProvenanceForOutput } from '../operations/adapters/headless.js';
import type {
  WorkflowExecutionRecord,
  WorkflowFrameRecord,
  WorkflowOperationRecord,
  WorkflowRunRecord,
} from '../persistence/records.js';
import { run } from '../persistence/test-support.js';
import {
  makeWorkflowRunProjection,
  type WorkflowRunProjectionOptions,
} from '../read/projection.service.js';
import type { WaitDeclaration } from '../types.js';

/**
 * Driving a fixture workflow: the harness, the external world, and the pass loop.
 *
 * Shared by every fixture rather than copied, because several suites now run this same pipeline for
 * different reasons — one asserts the records the engine wrote, one asserts what the read model
 * says about them, and the evidence fixtures assert what survived — and a second copy of the world
 * would let those views drift apart while all of them stayed green.
 *
 * It is generalised rather than merely relocated: the verdict callback is handed the operation's
 * *position* as well as a round number, because a fixture with more than one kind of judgment
 * cannot route on a global counter alone.
 */

export async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

/**
 * Where a headless judgment is being made, so a fixture can answer it differently by position.
 *
 * The execution and frame records are handed over whole rather than projected: a fixture routes on
 * `nodeId`, on the frame's `graphKey`, or on the dynamic `displayName` its own `label` produced,
 * and picking two of those three here would just mean coming back to add the third.
 */
export interface JudgmentContext {
  readonly record: WorkflowOperationRecord;
  readonly execution: WorkflowExecutionRecord;
  readonly frame: WorkflowFrameRecord;
}

/** What a stubbed provider "printed", for the fixtures that assert recorded provenance. */
export type RawHeadlessBody = (context: JudgmentContext) => string | null;

/**
 * The external world, driven deterministically.
 *
 * Every fabricated turn edge is anchored to the **submission watermark of the wait it answers**,
 * never to wall-clock time. That is not a detail: the watermark bounds the search for the turn a
 * prompt caused, so an edge stamped later than a *subsequent* submission would be a candidate for
 * that one too — and a later wait would either consume a turn nobody sent it or see two open starts
 * and settle `uncertain`. Either way the fixture, not the code, would be deciding the outcome.
 */
export class World {
  constructor(private readonly harness: EngineHarness) {}

  /** Ends every agent turn the run is currently waiting on. */
  async endTurns(runId: number): Promise<number> {
    const delivered = await this.answerTurns(runId, 'turn_ended');
    // What the resolver's subscriber does when a turn event reaches it. Called explicitly so the
    // test is deterministic, through the same `reconcileWaits` the subscriber calls.
    if (delivered > 0) await this.harness.deliver(runId);
    return delivered;
  }

  /** Fails the turn the run is waiting on, which is edge data the author routes on. */
  async failNextTurn(runId: number): Promise<void> {
    await this.answerTurns(runId, 'turn_failed');
    await this.harness.deliver(runId);
  }

  /**
   * Completes every headless judgment in flight.
   *
   * `raw` is the provider's own stdout, not a hand-assembled provenance block. It is run through
   * the **real** extractor the harness registry owns, so a fixture asserting "the stub reported a
   * session id and usage" is asserting that the extractor phase 02 confirmed against the installed
   * CLI still works — a hand-written `OperationSettlementProvenance` would stay green if that
   * extractor were deleted.
   */
  async completeJudgments(
    runId: number,
    output: (context: JudgmentContext) => string,
    raw?: RawHeadlessBody,
  ) {
    const unsettled = (await run(this.harness.fixture.operations.listUnsettled({ runId }))).filter(
      (record) => record.capability === 'run_headless_agent',
    );
    for (const record of unsettled) {
      const context = await this.contextOf(record);
      const body = raw?.(context) ?? null;
      const provenance =
        body === null ? null : headlessProvenanceForOutput(record.harness ?? 'claude', body);
      await this.harness.settleOperation({
        operationId: record.id,
        state: 'completed',
        result: { operationId: record.operationKey, status: 'completed', output: output(context) },
        ...(provenance === null
          ? {}
          : {
              provenance: {
                correlatedHarnessSessionId: provenance.harnessSessionId,
                usage: provenance.usage,
              },
            }),
      });
    }
    if (unsettled.length > 0) await this.harness.deliver(runId);
    return unsettled.length;
  }

  /** Where an operation sits in the tree, so a fixture can answer it by position. */
  async contextOf(record: WorkflowOperationRecord): Promise<JudgmentContext> {
    const execution = await run(this.harness.fixture.runs.findExecution(record.executionId));
    const frame = await run(this.harness.fixture.runs.findFrame(record.frameId));
    if (!execution || !frame) {
      throw new Error(`Operation ${record.operationKey} has no execution or frame.`);
    }
    return { record, execution, frame };
  }

  private async answerTurns(runId: number, terminal: 'turn_ended' | 'turn_failed') {
    const armed = await run(this.harness.fixture.runs.listArmedWaits(runId));
    let answered = 0;
    for (const waitRow of armed) {
      if (waitRow.waitKind !== 'agent_turn' || !waitRow.condition) continue;
      const declaration = (await run(
        this.harness.fixture.payloads.resolve(waitRow.condition),
      )) as Extract<WaitDeclaration, { kind: 'agent_turn' }>;
      const agentSessionId = declaration.target.agentSessionId;
      const edges = this.harness.adapters.turnEdges.get(agentSessionId) ?? [];
      const seq = edges.length + 1;
      const harnessSessionId = `harness-${agentSessionId}`;
      // Exactly at the watermark: satisfies `recordedAt >= sentAt` for this submission, and sorts
      // strictly before every submission made after it.
      const at = declaration.target.sentAt;
      edges.push({ type: 'turn_started', agentSessionId, harnessSessionId, seq, recordedAt: at });
      edges.push(
        terminal === 'turn_ended'
          ? { type: 'turn_ended', agentSessionId, harnessSessionId, seq, recordedAt: at }
          : {
              type: 'turn_failed',
              agentSessionId,
              harnessSessionId,
              seq,
              recordedAt: at,
              reason: 'harness_error',
            },
      );
      this.harness.adapters.turnEdges.set(agentSessionId, edges);
      answered += 1;
    }
    return answered;
  }
}

export interface DriveOptions {
  /** The provider stdout each judgment should be settled with, for the provenance assertions. */
  readonly raw?: RawHeadlessBody | undefined;
  /** Passes higher than the default, for fixtures that loop more than the story one does. */
  readonly maxPasses?: number | undefined;
}

/**
 * Runs the pipeline until it stops making progress on its own.
 *
 * Each pass drains, then answers whatever external work the run is now waiting on, which is the
 * shape the real system has too: the dispatcher advances, the world answers, the resolver delivers.
 *
 * `verdicts` receives both a global, monotonic round number — which is all the single-judgment
 * story fixture ever needed — and the position the judgment is being made at, which is what a
 * fixture with several distinct judgments routes on. The round is passed first and separately
 * rather than folded into the context so the original call sites read unchanged.
 */
export async function drivePipeline(
  harness: EngineHarness,
  runId: number,
  verdicts: (round: number, context: JudgmentContext) => string,
  options: DriveOptions = {},
): Promise<WorkflowRunRecord> {
  const world = new World(harness);
  let round = 0;
  const maxPasses = options.maxPasses ?? 40;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    await harness.drain();
    const current = await harness.runOf(runId);
    if (
      current.status === 'done' ||
      current.status === 'failed' ||
      current.status === 'cancelled'
    ) {
      return current;
    }
    const judged = await world.completeJudgments(
      runId,
      (context) => {
        round += 1;
        return verdicts(round, context);
      },
      options.raw,
    );
    const turns = await world.endTurns(runId);
    if (judged === 0 && turns === 0) return current;
  }
  return harness.runOf(runId);
}

/**
 * The read model over the same database the harness just wrote.
 *
 * Shared so every fixture asks the *production* projection what it recorded, rather than reading
 * rows directly and proving only that SQLite works. Rows are still read directly where the claim is
 * about storage itself — an unreferenced blob, a column that must stay null.
 */
export function projectionOf(harness: EngineHarness, options: WorkflowRunProjectionOptions = {}) {
  return makeWorkflowRunProjection(
    harness.fixture.database,
    harness.fixture.payloads,
    harness.fixture.content,
    options,
  );
}

/**
 * One evidence row, as the table stores it.
 *
 * Read raw, deliberately: most assertions go through the projection, but a claim about *storage*
 * — a column that must stay null, a digest two captures must share — has to look at the row.
 */
export interface EvidenceRow {
  readonly id: number;
  readonly evidence_key: string;
  readonly run_id: number;
  readonly frame_id: number;
  readonly execution_id: number;
  readonly attempt_id: number;
  readonly operation_id: number;
  readonly artifact_hash: string;
  readonly title: string;
  readonly role: string;
  readonly labels_json: string | null;
  readonly content_kind: string;
  readonly media_type: string;
  readonly byte_size: number;
  readonly content_ref: string;
  readonly source_path: string | null;
  readonly source_kind: string;
  readonly source_agent_session_id: number | null;
  readonly source_operation_id: number | null;
  readonly source_attribution: string;
  readonly captured_at: string;
}

export const evidenceRows = (harness: EngineHarness): EvidenceRow[] =>
  harness.fixture.client
    .prepare('SELECT * FROM workflow_evidence ORDER BY id')
    .all() as EvidenceRow[];

/**
 * The filters a fixture may ask the listing for.
 *
 * Typed against the route's own query rather than `Record<string, unknown>`, so a rename in
 * contracts fails here at compile time instead of surfacing as a puzzling empty result set.
 */
export type EvidenceFilter = Omit<Partial<ListWorkflowEvidenceQuery>, 'limit' | 'cursor'>;

/**
 * Every captured record for a run, through the production read model, paged to exhaustion.
 *
 * The page size is deliberately small so that every caller exercises the cursor rather than
 * accidentally fitting in one page and never discovering that paging is broken.
 */
export async function listAllEvidence(
  harness: EngineHarness,
  runId: number,
  query: EvidenceFilter = {},
): Promise<WorkflowEvidenceDto[]> {
  const projection = projectionOf(harness);
  const items: WorkflowEvidenceDto[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await run(
      projection.listEvidence(runId, {
        limit: 5,
        ...query,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
}

/** The bytes as the content route would stream them, verified at the last byte on the way out. */
export async function evidenceContent(
  harness: EngineHarness,
  runId: number,
  evidenceKey: string,
): Promise<Buffer> {
  const response = await run(projectionOf(harness).openEvidenceContent(runId, evidenceKey));
  const chunks: Buffer[] = [];
  for await (const chunk of response.stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

export async function evidenceText(
  harness: EngineHarness,
  runId: number,
  evidenceKey: string,
): Promise<string> {
  return (await evidenceContent(harness, runId, evidenceKey)).toString('utf8');
}

/** A run's captures as a sorted `(role, labels)` multiset — the shape the story sketches. */
export const evidenceShape = (items: readonly WorkflowEvidenceDto[]) =>
  items
    .map((item) => `${item.role}${JSON.stringify(item.labels)}`)
    .sort((a, b) => a.localeCompare(b));

/** The run's root frame, which is where every failed root-level attempt is recorded. */
export async function rootFrameId(harness: EngineHarness, runId: number): Promise<number> {
  const frames = await run(harness.fixture.runs.listFrames(runId));
  return frames.find((frame) => frame.depth === 0)!.id;
}

/**
 * One operation's settlement history, in order, with each transition's detail resolved.
 *
 * The durable form of a sequence claim. A state sampled between two awaits can only say what the
 * row reads *now*, and the interesting states here are transient inside a single drain — reconcile
 * abandons the row, dispatch re-enters the callback, and the commit reopens it. History keeps all
 * three, so the whole `intended → abandoned → reopened → completed` claim is one read at the end
 * with no timing assumption in it.
 */
export async function operationHistory(
  harness: EngineHarness,
  operationKey: string,
): Promise<readonly { readonly kind: string; readonly detail: unknown }[]> {
  const rows = harness.fixture.client
    .prepare(
      `SELECT t.kind AS kind, t.detail_inline AS detail_inline, t.detail_ref AS detail_ref
         FROM workflow_transitions t
         JOIN workflow_operations o ON o.id = t.operation_id
        WHERE o.operation_key = ?
        ORDER BY t.id ASC`,
    )
    .all(operationKey) as {
    kind: string;
    detail_inline: string | null;
    detail_ref: string | null;
  }[];
  const resolved: { kind: string; detail: unknown }[] = [];
  for (const row of rows) {
    const detail =
      row.detail_inline === null && row.detail_ref === null
        ? null
        : await run(
            harness.fixture.payloads.resolve(
              row.detail_inline === null
                ? { inline: null, ref: row.detail_ref! }
                : { inline: row.detail_inline, ref: null },
            ),
          );
    resolved.push({ kind: row.kind, detail });
  }
  return resolved;
}

/** One capture operation's durable row, by the position it claimed. */
export function captureOperations(harness: EngineHarness, runId: number) {
  return harness.fixture.client
    .prepare(
      `SELECT operation_key, state FROM workflow_operations
        WHERE capability = 'capture_evidence' AND run_id = ? ORDER BY id ASC`,
    )
    .all(runId) as { operation_key: string; state: string }[];
}
