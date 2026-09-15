import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { WorkflowStructureDescriptor } from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { Effect } from 'effect';

import {
  makeWorkflowPersistenceFixture,
  prepareClaim,
  run,
  type WorkflowPersistenceFixture,
} from '../persistence/test-support.js';
import { makeWorkflowArtifactCatalog } from './artifact-catalog.js';
import { validateSavedPositions } from './retry-validation.js';

const PIN_A = 'a'.repeat(64);
const PIN_B = 'b'.repeat(64);
const OWNER = 'worker-1';
const INCARNATION = 'incarnation-1';

/** The candidate structure a Retry would adopt: it no longer declares the node the run sits on. */
const incompatible: WorkflowStructureDescriptor = {
  descriptorVersion: 1,
  workflowContractVersion: 2,
  rootGraphKey: 'root',
  graphs: [
    {
      key: 'root',
      title: 'root',
      stateFields: ['count'],
      entry: 'renamed',
      nodes: [{ id: 'renamed', kind: 'operation' }],
      edges: [{ id: 'renamed-out', from: 'renamed', to: ['finished'] }],
      outcomes: [{ id: 'finished', kind: 'success' }],
    },
  ],
};

function catalogFor(fixture: WorkflowPersistenceFixture) {
  return makeWorkflowArtifactCatalog(fixture.database, fixture.payloads, {
    cacheRoot: `${fixture.root}/workflow-artifacts`,
    definitionCache: new Map(),
  });
}

test('a rejected Retry may leave an unused catalog entry but changes nothing about the run', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    fixture.seedArtifact(PIN_A);
    const placement = fixture.seedPlacement();
    const created = await run(
      fixture.runs.createRun({
        workflowKey: 'fixture',
        title: 'Fixture',
        rootGraphKey: 'root',
        artifactHash: PIN_A,
        rootFrame: { graphKey: 'root' },
        origin: {
          worktreeId: placement.worktreeId,
          worktreePath: '/repo/fixture',
          surfaceId: placement.surfaceId,
          paneId: null,
          agentSessionId: null,
        },
        destination: {
          worktreeId: placement.worktreeId,
          worktreePath: '/repo/fixture',
          surfaceId: placement.surfaceId,
        },
        attachment: { worktreeId: placement.worktreeId, surfaceId: placement.surfaceId },
      }),
    );
    assert.ok(created.ok);
    const frameId = created.value.frame.id;

    // Drive the run to a failed node callback, which is where a Retry would be offered.
    const entry = await run(
      fixture.runs.claimSegment({
        ...(await prepareClaim(fixture, created.value.run.id)),
        owner: OWNER,
        ownerIncarnation: INCARNATION,
      }),
    );
    assert.ok(entry.ok);
    await run(
      fixture.runs.commitGraphEntry({
        runId: created.value.run.id,
        attemptId: entry.value.attempt.id,
        owner: OWNER,
        ownerIncarnation: INCARNATION,
        frameId,
        state: { value: { count: 0 } },
        entryNode: { nodeId: 'work', nodeKind: 'operation' },
      }),
    );
    let current = (await run(fixture.runs.findRun(created.value.run.id)))!;
    const callback = await run(
      fixture.runs.claimSegment({
        ...(await prepareClaim(fixture, current.id)),
        owner: OWNER,
        ownerIncarnation: INCARNATION,
      }),
    );
    assert.ok(callback.ok);
    await run(
      fixture.runs.failSegment({
        runId: current.id,
        attemptId: callback.value.attempt.id,
        owner: OWNER,
        ownerIncarnation: INCARNATION,
        code: 'node_callback_failed',
        message: 'boom',
      }),
    );
    current = (await run(fixture.runs.findRun(created.value.run.id)))!;

    const before = {
      pin: current.artifactHash,
      status: current.status,
      position: current.position,
      revision: current.revision,
      controlRevision: current.controlRevision,
      failureCode: current.failureCode,
      attempts: await run(fixture.runs.listAttemptsForFrame(frameId)),
      adoptions: await run(fixture.runs.listVersionAdoptions(current.id)),
    };
    assert.equal(before.adoptions.length, 1, 'only the launch adoption so far');

    // Publication is independent of adoption: the candidate version is recorded in the catalog
    // *before* anything decides whether the run may move to it.
    const catalog = catalogFor(fixture);
    fixture.seedArtifact(PIN_B);
    const published = await run(catalog.findRecord(PIN_B));
    assert.ok(published, 'the candidate version is in the catalog');

    const execution = (await run(fixture.runs.findExecution(callback.value.attempt.executionId!)))!;
    const diagnostics = validateSavedPositions({
      descriptor: incompatible,
      frames: await run(fixture.runs.listActiveFrames(current.id)),
      position: current.position,
      execution,
    });
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['node_missing'],
    );

    // Rejected, so the control is never applied. Everything the run owns is byte-identical, and the
    // unused catalog row is inert history rather than a pin anyone adopted.
    const after = (await run(fixture.runs.findRun(created.value.run.id)))!;
    assert.equal(after.artifactHash, before.pin);
    assert.equal(after.status, before.status);
    assert.deepEqual(after.position, before.position);
    assert.equal(after.revision, before.revision);
    assert.equal(after.controlRevision, before.controlRevision);
    assert.equal(after.failureCode, before.failureCode);
    assert.deepEqual(await run(fixture.runs.listAttemptsForFrame(frameId)), before.attempts);
    assert.deepEqual(await run(fixture.runs.listVersionAdoptions(after.id)), before.adoptions);
    assert.ok(await run(catalog.findRecord(PIN_B)), 'the unused entry is permitted to remain');
  } finally {
    fixture.close();
  }
});

test('a retained descriptor is read as data, proven by a cache that would throw if imported', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    // The tripwire: the artifact cache this catalog is pointed at contains a module that throws on
    // import. Reading a descriptor must never touch it — the whole reason structure is retained as
    // data is that an old version may be unloadable, built by a different SDK, or unsafe to run,
    // and the inspector still has to describe it. Nothing in production changes to make this
    // observable; the cache is simply real and poisoned.
    const cacheRoot = join(fixture.root, 'workflow-artifacts');
    mkdirSync(join(cacheRoot, PIN_A), { recursive: true });
    writeFileSync(
      join(cacheRoot, PIN_A, 'index.mjs'),
      'throw new Error("readDescriptor imported executable artifact code");\n',
    );

    const catalog = makeWorkflowArtifactCatalog(fixture.database, fixture.payloads, {
      cacheRoot,
      definitionCache: new Map(),
    });

    const slot = await run(fixture.payloads.publish(incompatible));
    fixture.client
      .prepare(
        `INSERT INTO workflow_artifacts (
           artifact_hash, workflow_key, contract_version, manifest_version, descriptor_version,
           sdk_version, verifier_version, source_hash, structure_hash, root_graph_key,
           descriptor_inline, descriptor_ref, first_seen_at
         ) VALUES (?, 'fixture', 2, 2, 1, '0.1.0', '0.1.0', ?, ?, 'root', ?, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(PIN_A, 's'.repeat(64), 'h'.repeat(64), slot.inline, slot.ref);

    const descriptor = await run(catalog.readDescriptor(PIN_A));
    assert.deepEqual(descriptor, incompatible);
    assert.equal(await run(catalog.readDescriptor(PIN_B)), null, 'an unknown pin is absent');

    // And the tripwire is genuinely armed: loading that same pin as *code* does fail.
    const loaded = await Effect.runPromise(
      Effect.either(catalog.loadPinned({ artifactHash: PIN_A })),
    );
    assert.equal(loaded._tag, 'Left');
  } finally {
    fixture.close();
  }
});
