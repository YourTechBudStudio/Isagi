import assert from 'node:assert/strict';

import { Effect } from 'effect';

import type {
  RuntimeEvent,
  WorkflowPlacementRequestDto,
  WorkflowPlacementSource,
} from '@isagi/contracts';

import type { RuntimeEventBusService } from '../../runtime-events/event-bus.js';
import type { ResolvedSource } from '../evidence/source.js';
import type { WorkflowWriteResult } from '../persistence/outcomes.js';
import {
  createPlacedRun,
  createPreparingRun,
  makeWorkflowPersistenceFixture,
  prepareClaim,
  run,
  type WorkflowPersistenceFixture,
} from '../persistence/test-support.js';
import {
  makeWorkflowRunProjection,
  type WorkflowRunProjectionOptions,
} from './projection.service.js';
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

export function makeReadHarness(options: WorkflowRunProjectionOptions = {}): ReadHarness {
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
    projection: makeWorkflowRunProjection(
      fixture.database,
      fixture.payloads,
      fixture.content,
      options,
    ),
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

/**
 * Creates a run that is still *preparing*: no destination, no attachment, one claimed attempt.
 *
 * `startRun`'s counterpart, stopping where a launch stops rather than committing: almost everything
 * downstream is about what happens after a run is placed, and these tests are about the state
 * before that. The run itself is built by `createPreparingRun`, which `createPlacedRun` also builds
 * on, so there is one composition of the launch fixture and not two. What is added here is what the
 * read harness needs around it — both pins seeded, a placement seeded, and the harness's own owner
 * so the `fence` helper matches the claim.
 */
export async function startPreparingRun(
  fixture: WorkflowPersistenceFixture,
  options: {
    readonly source?: WorkflowPlacementSource;
    readonly request?: WorkflowPlacementRequestDto;
    readonly baseCommit?: string | null;
    readonly checkoutPath?: string | null;
  } = {},
) {
  fixture.seedArtifact(PIN_A);
  fixture.seedArtifact(PIN_B);
  const placement = fixture.seedPlacement();
  const created = await createPreparingRun(fixture, {
    workflowKey: 'fixture',
    title: 'Fixture run',
    rootGraphKey: 'root',
    artifactHash: PIN_A,
    rootFrame: { graphKey: 'root', parameters: { value: { topic: 'graphs' } } },
    placement,
    owner: OWNER,
    ownerIncarnation: INCARNATION,
    preparation: {
      source: options.source ?? 'default',
      request: options.request ?? { worktree: { kind: 'current' }, surface: { kind: 'current' } },
      baseCommit: options.baseCommit ?? null,
      checkoutPath: options.checkoutPath ?? null,
    },
  });
  return {
    runId: created.run.id,
    rootFrameId: created.frame.id,
    attemptId: created.attempt.id,
    placement,
  };
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

/**
 * One capture, driven through the same two writes the verb makes.
 *
 * Deliberately not a direct insert into `workflow_evidence`: the guarantee under test is that a row
 * exists exactly when its operation is `completed`, and only `commitCapture` establishes it. The
 * intent is recorded first so the operation sits at `intended`, then the bytes are published, then
 * the capture transaction settles the operation and writes the row together.
 */
export async function captureEvidence(
  fixture: WorkflowPersistenceFixture,
  input: {
    readonly runId: number;
    readonly frameId: number;
    readonly executionId: number;
    readonly attemptId: number;
    readonly callIndex: number;
    readonly title: string;
    readonly role: string;
    readonly labels?: Readonly<Record<string, string | number | boolean>> | undefined;
    readonly bytes?: Buffer | undefined;
    readonly mediaType?: string | undefined;
    readonly source?: ResolvedSource | undefined;
    readonly artifactHash?: string | undefined;
    /** Stop after the intent, leaving the capture `intended` with no evidence row. */
    readonly settle?: boolean | undefined;
  },
) {
  const artifactHash = input.artifactHash ?? PIN_A;
  const operation = value(
    await run(
      fixture.operations.recordIntent({
        runId: input.runId,
        frameId: input.frameId,
        executionId: input.executionId,
        originAttemptId: input.attemptId,
        capability: 'capture_evidence',
        callIndex: input.callIndex,
        request: { value: { title: input.title, role: input.role } },
        fingerprintOf: { value: { title: input.title, role: input.role } },
        artifactHash,
        provenance: {
          harness: null,
          model: null,
          effort: null,
          cwd: null,
          runtimeId: 'runtime-1',
          incarnationId: INCARNATION,
        },
      }),
    ),
  );
  if (input.settle === false) return { operation, evidence: null };

  const mediaType = input.mediaType ?? 'text/plain';
  const published = await run(
    fixture.content.put({
      source: input.bytes ?? Buffer.from(input.title),
      mediaTypeHint: mediaType,
    }),
  );
  const evidence = value(
    await run(
      fixture.evidence.commitCapture({
        operation,
        attemptId: input.attemptId,
        title: input.title,
        role: input.role,
        labels: input.labels ?? null,
        contentKind: 'text',
        mediaType,
        byteSize: published.byteSize,
        contentRef: published.contentRef,
        sourcePath: null,
        source: input.source ?? {
          kind: 'none',
          agentSessionId: null,
          operationId: null,
          attribution: 'none',
        },
        now: new Date().toISOString(),
      }),
    ),
  );
  return { operation, evidence };
}

export { run, makeWorkflowPersistenceFixture, type WorkflowPersistenceFixture };
