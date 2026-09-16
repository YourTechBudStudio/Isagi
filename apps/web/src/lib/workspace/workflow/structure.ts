import type { QueryClient } from '@tanstack/react-query';

import type { GetWorkflowStructureOutput } from '@isagi/contracts';

import { workflowDescriptorQueryKey } from '../query-keys.js';
import { requestRunRecovery } from './signals.js';

/**
 * The run has moved on, so the structure that just arrived is not the one the caller asked about.
 *
 * Its own name: a mismatch is neither a transport failure nor a corrupt payload, and reporting it as
 * either would send someone looking for a problem that is not there. Nothing has gone wrong except
 * that the caller's idea of the current pin is out of date.
 */
export class WorkflowStructureStaleError extends Error {
  constructor(
    readonly expectedArtifactHash: string,
    readonly currentArtifactHash: string,
  ) {
    super(
      `The run has moved to pin ${currentArtifactHash}; the structure for ${expectedArtifactHash} is no longer current.`,
    );
    this.name = 'WorkflowStructureStaleError';
  }
}

/**
 * Resolves the run's current structure against two separate caches.
 *
 * The request deliberately does not name a pin — the amendment's rule is that the client always asks
 * for the run's *current* structure — so the response may legitimately describe a pin the caller did
 * not ask for, because a Retry can land while the request is in flight. That is the whole hazard:
 * storing such a response under the hash the caller expected would cache a descriptor forever under
 * a hash it does not describe.
 *
 * So the validated descriptor is always written under the hash the response itself reported, and a
 * mismatch is refused rather than returned. Nothing renders under the old pin, not even for a frame;
 * the run's coordinator is asked for a narrow recovery, and the caller re-keys once the summary
 * converges on the pin that is actually current.
 */
export async function resolveCurrentStructure(input: {
  readonly queryClient: QueryClient;
  readonly runtimeIdentity: string | null;
  readonly runId: number;
  readonly expectedArtifactHash: string;
  readonly fetchStructure: () => Promise<GetWorkflowStructureOutput>;
}): Promise<GetWorkflowStructureOutput> {
  const structure = await input.fetchStructure();

  // Under its own hash either way. A descriptor is immutable and self-describing, so the only wrong
  // place to put it is under a hash that is not its own — and a newer one is a perfectly good answer
  // to a question nobody has asked yet.
  input.queryClient.setQueryData(
    workflowDescriptorQueryKey(input.runtimeIdentity, structure.artifactHash),
    structure,
  );

  if (structure.artifactHash !== input.expectedArtifactHash) {
    requestRunRecovery(input.runId);
    throw new WorkflowStructureStaleError(input.expectedArtifactHash, structure.artifactHash);
  }
  return structure;
}
