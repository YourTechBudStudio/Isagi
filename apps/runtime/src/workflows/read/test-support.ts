import assert from 'node:assert/strict';

import { Effect } from 'effect';

import type { RuntimeEvent } from '@isagi/contracts';

import type { RuntimeEventBusService } from '../../runtime-events/event-bus.js';
import type { WorkflowWriteResult } from '../persistence/outcomes.js';
import {
  createPlacedRun,
  makeWorkflowPersistenceFixture,
  prepareClaim,
  run,
  type WorkflowPersistenceFixture,
} from '../persistence/test-support.js';
import { makeWorkflowRunProjection } from './projection.service.js';
import { makeWorkflowDeltaPublisher } from './publisher.js';

/**
 * A read model over a real database, with the engine replaced by explicit repository writes.
 *
 * The interpreter has its own suites; what these need is the ability to produce an *exact* durable
 * situation — a repaired attempt under a second pin, an operation that settles after its attempt
 * ended, a transaction that writes several transitions — and then ask the read model what it says.
 * Driving that through the interpreter would mean arranging a workflow that happens to produce it.
 */

export const PIN_A = 'a'.repeat(64);
export const PIN_B = 'b'.repeat(64);
const OWNER = 'worker-1';
const INCARNATION = 'incarnation-1';

export interface ReadHarness {
  readonly fixture: WorkflowPersistenceFixture;
  readonly projection: ReturnType<typeof makeWorkflowRunProjection>;
  readonly publisher: ReturnType<typeof makeWorkflowDeltaPublisher>;
  /** Everything the publisher has put on the public bus, in publication order. */
  readonly events: RuntimeEvent[];
  readonly close: () => void;
}

export function makeReadHarness(): ReadHarness {
  const fixture = makeWorkflowPersistenceFixture();
  const events: RuntimeEvent[] = [];
  const bus: Pick<RuntimeEventBusService, 'publish'> = {
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
  };
  return {
    fixture,
    projection: makeWorkflowRunProjection(fixture.database, fixture.payloads),
    publisher: makeWorkflowDeltaPublisher(fixture.database, bus, 0),
    events,
    close: fixture.close,
  };
}

export function value<A>(result: WorkflowWriteResult<A>): A {
  assert.ok(result.ok, `expected a commit, got ${JSON.stringify(result)}`);
  return result.value;
}

export function fence(runId: number, attemptId: number) {
  return { runId, attemptId, owner: OWNER, ownerIncarnation: INCARNATION };
}

/** Creates a run with both pins registered and a live placement, as a launch would. */
export async function startRun(
  fixture: WorkflowPersistenceFixture,
  options: { readonly workflowKey?: string; readonly title?: string } = {},
) {
  fixture.seedArtifact(PIN_A);
  fixture.seedArtifact(PIN_B);
  const placement = fixture.seedPlacement();
  const created = await createPlacedRun(fixture, {
    workflowKey: options.workflowKey ?? 'fixture',
    title: options.title ?? 'Fixture run',
    rootGraphKey: 'root',
    artifactHash: PIN_A,
    rootFrame: { graphKey: 'root', parameters: { value: { topic: 'graphs' } } },
    placement,
  });
  return { runId: created.run.id, rootFrameId: created.frame.id, placement };
}

/** Claims whatever segment the run is parked at, the way the dispatcher would. */
export async function claim(fixture: WorkflowPersistenceFixture, runId: number) {
  const current = (await run(fixture.runs.findRun(runId)))!;
  const claimed = value(
    await run(
      fixture.runs.claimSegment({
        ...(await prepareClaim(fixture, runId)),
        owner: OWNER,
        ownerIncarnation: INCARNATION,
      }),
    ),
  );
  return { run: current, attempt: claimed.attempt };
}

export async function currentRun(fixture: WorkflowPersistenceFixture, runId: number) {
  return (await run(fixture.runs.findRun(runId)))!;
}

/** Enters the root graph and dispatches its entry node. */
export async function enterRoot(
  fixture: WorkflowPersistenceFixture,
  input: {
    readonly runId: number;
    readonly frameId: number;
    readonly nodeId: string;
    readonly nodeKind?: 'operation' | 'subgraph';
    readonly state?: unknown;
  },
) {
  const entry = await claim(fixture, input.runId);
  value(
    await run(
      fixture.runs.commitGraphEntry({
        ...fence(input.runId, entry.attempt.id),
        frameId: input.frameId,
        state: { value: input.state ?? { rounds: 0 } },
        entryNode: { nodeId: input.nodeId, nodeKind: input.nodeKind ?? 'operation' },
      }),
    ),
  );
  const executions = await run(fixture.runs.listExecutions(input.frameId));
  return executions.at(-1)!;
}

export { run, makeWorkflowPersistenceFixture, type WorkflowPersistenceFixture };
