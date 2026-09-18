import { makeEngineHarness, type EngineHarness } from '../../engine/test-support.js';
import { run } from '../../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import type { WaitDeclaration } from '../../types.js';
import { reviewedDocumentWorkflow } from './index.js';

/**
 * Driving the story fixture: the harness, the external world, and the pass loop.
 *
 * Shared rather than copied, because two suites now run this same pipeline for different reasons —
 * one asserts the records the engine wrote, the other asserts what the read model says about them —
 * and a second copy of the world would let those two views drift apart while both stayed green.
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

  /** Completes every headless judgment in flight with the given text. */
  async completeJudgments(runId: number, output: () => string) {
    const unsettled = (await run(this.harness.fixture.operations.listUnsettled({ runId }))).filter(
      (record) => record.capability === 'run_headless_agent',
    );
    for (const record of unsettled) {
      await this.harness.settleOperation({
        operationId: record.id,
        state: 'completed',
        result: { operationId: record.operationKey, status: 'completed', output: output() },
      });
    }
    if (unsettled.length > 0) await this.harness.deliver(runId);
    return unsettled.length;
  }
}

/**
 * Runs the pipeline until it stops making progress on its own.
 *
 * Each pass drains, then answers whatever external work the run is now waiting on, which is the
 * shape the real system has too: the dispatcher advances, the world answers, the resolver delivers.
 */
export async function drivePipeline(
  harness: EngineHarness,
  runId: number,
  verdicts: (round: number) => string,
) {
  const world = new World(harness);
  let round = 0;
  for (let pass = 0; pass < 40; pass += 1) {
    await harness.drain();
    const current = await harness.runOf(runId);
    if (
      current.status === 'done' ||
      current.status === 'failed' ||
      current.status === 'cancelled'
    ) {
      return current;
    }
    const judged = await world.completeJudgments(runId, () => {
      round += 1;
      return verdicts(round);
    });
    const turns = await world.endTurns(runId);
    if (judged === 0 && turns === 0) return current;
  }
  return harness.runOf(runId);
}

export function publishFixture(harness: EngineHarness, version = '1') {
  return harness.publish({
    workflowKey: 'reviewed-document',
    version,
    definition: reviewedDocumentWorkflow as unknown as AnyWorkflowDefinition,
  });
}
