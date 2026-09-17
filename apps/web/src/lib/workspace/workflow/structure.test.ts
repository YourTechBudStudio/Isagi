import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import type { GetWorkflowStructureOutput } from '@isagi/contracts';

import { workflowDescriptorQueryKey } from '../query-keys.js';
import { subscribeToWorkflowSignals, type WorkflowSignal } from './signals.js';
import { resolveCurrentStructure, WorkflowStructureStaleError } from './structure.js';

const identity = 'http://runtime.test';
const runId = 1;

test('a response that matches the expected pin is served and cached under its own hash', async () => {
  const client = new QueryClient();
  const structure = await resolveCurrentStructure({
    queryClient: client,
    runtimeIdentity: identity,
    runId,
    expectedArtifactHash: 'sha256:a',
    fetchStructure: () => Promise.resolve(structureFor('sha256:a')),
  });

  assert.equal(structure.artifactHash, 'sha256:a');
  assert.equal(descriptor(client, 'sha256:a')?.artifactHash, 'sha256:a');
});

test('a Retry landing mid-request cannot poison either immutable key', async () => {
  const client = new QueryClient();
  const signals: WorkflowSignal[] = [];
  const unsubscribe = subscribeToWorkflowSignals((signal) => signals.push(signal));

  // The request for A is in flight; the run adopts B; the response therefore describes B while the
  // caller is still asking about A. This is the race the two-boundary split exists for.
  await assert.rejects(
    resolveCurrentStructure({
      queryClient: client,
      runtimeIdentity: identity,
      runId,
      expectedArtifactHash: 'sha256:a',
      fetchStructure: () => Promise.resolve(structureFor('sha256:b')),
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowStructureStaleError);
      assert.equal(error.expectedArtifactHash, 'sha256:a');
      assert.equal(error.currentArtifactHash, 'sha256:b');
      return true;
    },
  );
  unsubscribe();

  // Nothing is cached under the pin that was asked about: the old pin has no descriptor at all
  // rather than the wrong one, so there is no way to draw B's graph as if it were A's.
  assert.equal(descriptor(client, 'sha256:a'), undefined);
  // B's descriptor is kept, because it is a correct answer under its own hash.
  assert.equal(descriptor(client, 'sha256:b')?.artifactHash, 'sha256:b');
  // And the run is asked to catch up, so the client learns the newer pin rather than waiting for a
  // live event that may never come.
  assert.deepEqual(
    signals.filter((signal) => signal.type === 'recovery_requested'),
    [{ type: 'recovery_requested', runId }],
  );
});

test('the newer pin resolves normally once the caller re-keys onto it', async () => {
  const client = new QueryClient();
  await assert.rejects(
    resolveCurrentStructure({
      queryClient: client,
      runtimeIdentity: identity,
      runId,
      expectedArtifactHash: 'sha256:a',
      fetchStructure: () => Promise.resolve(structureFor('sha256:b')),
    }),
  );

  // After the summary converges the caller asks about B, and the same response now matches.
  const structure = await resolveCurrentStructure({
    queryClient: client,
    runtimeIdentity: identity,
    runId,
    expectedArtifactHash: 'sha256:b',
    fetchStructure: () => Promise.resolve(structureFor('sha256:b')),
  });
  assert.equal(structure.artifactHash, 'sha256:b');
  assert.equal(descriptor(client, 'sha256:a'), undefined);
});

test('a late mismatched response cannot overwrite a descriptor already stored under its hash', async () => {
  const client = new QueryClient();
  await resolveCurrentStructure({
    queryClient: client,
    runtimeIdentity: identity,
    runId,
    expectedArtifactHash: 'sha256:a',
    fetchStructure: () => Promise.resolve(structureFor('sha256:a', 1)),
  });

  // A straggler for A arrives after the run moved to B. It describes A, so it lands on A — and it
  // cannot land on B, which is the only way this could corrupt anything.
  await assert.rejects(
    resolveCurrentStructure({
      queryClient: client,
      runtimeIdentity: identity,
      runId,
      expectedArtifactHash: 'sha256:b',
      fetchStructure: () => Promise.resolve(structureFor('sha256:a', 1)),
    }),
  );

  assert.equal(descriptor(client, 'sha256:a')?.pinOrdinal, 1);
  assert.equal(descriptor(client, 'sha256:b'), undefined);
});

test('descriptors are namespaced by runtime, so two runtimes cannot share one entry', async () => {
  const client = new QueryClient();
  await resolveCurrentStructure({
    queryClient: client,
    runtimeIdentity: identity,
    runId,
    expectedArtifactHash: 'sha256:a',
    fetchStructure: () => Promise.resolve(structureFor('sha256:a')),
  });

  assert.equal(descriptor(client, 'sha256:a')?.artifactHash, 'sha256:a');
  assert.equal(
    client.getQueryData(workflowDescriptorQueryKey('http://other.test', 'sha256:a')),
    undefined,
  );
});

function descriptor(
  client: QueryClient,
  artifactHash: string,
): GetWorkflowStructureOutput | undefined {
  return client.getQueryData<GetWorkflowStructureOutput>(
    workflowDescriptorQueryKey(identity, artifactHash),
  );
}

function structureFor(artifactHash: string, pinOrdinal = 1): GetWorkflowStructureOutput {
  return {
    artifactHash,
    workflowKey: 'review',
    sdkVersion: '0.1.0',
    verifierVersion: '0.1.0',
    pinOrdinal,
    adoptedAt: '2026-09-15T10:00:00.000Z',
    descriptor: {
      descriptorVersion: 1,
      workflowContractVersion: 3,
      rootGraphKey: 'root',
      graphs: [],
    },
  };
}
