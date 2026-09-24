export const workspaceQueryKey = ['workspace'] as const;
export const activeContextQueryKey = ['workspace', 'active-context'] as const;
export const surfaceDetailQueryKey = (surfaceId: number | null) => ['surface', surfaceId] as const;
export const worktreeCommandsQueryKey = (worktreeId: number | null) =>
  ['worktree', worktreeId, 'commands'] as const;
export const commandLogMetadataQueryKey = (worktreeId: number | null, commandName: string | null) =>
  ['worktree', worktreeId, 'commands', 'log-metadata', commandName] as const;

/**
 * The identity of the runtime a workflow cache belongs to.
 *
 * Every workflow key hangs off it. There is no runtime-issued id on the wire, so this is the
 * normalized runtime URL (`runtime-data.ts`). It is a namespace, not a fetch parameter: converged
 * run state and the coordinator's revision bookkeeping are only meaningful against the runtime that
 * produced them, and reusing either across a configuration change would be a silent lie.
 */
export const runtimeIdentityQueryKey = ['runtime', 'identity'] as const;

export const workflowDescriptorsQueryKey = (
  runtimeIdentity: string | null,
  worktreeId: number | null,
  surfaceId: number | null,
  paneId: number | null,
  agentSessionId: number | null,
) =>
  [
    'workflows',
    runtimeIdentity,
    'descriptors',
    { worktreeId, surfaceId, paneId, agentSessionId },
  ] as const;

/** Every summary the runtime reports as occupying a surface right now. */
export const workflowAttachedRunsQueryKey = (runtimeIdentity: string | null) =>
  ['workflows', runtimeIdentity, 'attached'] as const;

/**
 * One canonical, synchronized projection per run: entity maps, stable execution order and the
 * revision coverage the coordinator has actually established. Hooks select from it; nothing else
 * caches a mutable copy of a frame, execution or operation.
 */
export const workflowRunStateQueryKey = (runtimeIdentity: string | null, runId: number | null) =>
  ['workflows', runtimeIdentity, 'run-state', runId] as const;

/**
 * The bar's bounded recent-activity window. Never recovery coverage.
 *
 * Deliberately carries no "which opening" component. The read is a point-in-time one — bounded
 * below, open above — so it is kept stale rather than distinguished: the query re-reads for every
 * new subscription instead of being given an identity that would have to outlive the cache entry.
 */
export const workflowLogQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  sinceRevision: number,
) => ['workflows', runtimeIdentity, 'log', runId, sinceRevision] as const;

export const workflowCurrentStructureQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  expectedArtifactHash: string | null,
) => ['workflows', runtimeIdentity, 'current-structure', runId, expectedArtifactHash] as const;

/**
 * Keyed by content alone within the runtime namespace: a descriptor belongs to an artifact hash, not
 * to the run that happened to fetch it, so two runs on the same pin share one entry.
 */
export const workflowDescriptorQueryKey = (
  runtimeIdentity: string | null,
  artifactHash: string | null,
) => ['workflows', runtimeIdentity, 'descriptor', artifactHash] as const;

/**
 * One visit's operation hydration, keyed on the baseline it was read against.
 *
 * The entry holds completion metadata only — the rows go into the run projection, which stays the
 * one place an operation is read from. The epoch is in the key because a replaced baseline can come
 * back without rows this read accounted for, and a cached "complete" would then be a claim about a
 * projection that no longer exists.
 */
export const workflowExecutionOperationsQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  executionId: number | null,
  hydrationEpoch: number,
) =>
  [
    'workflows',
    runtimeIdentity,
    'execution-operations',
    runId,
    executionId,
    hydrationEpoch,
  ] as const;

/** Immutable once written, like a descriptor: the bytes a reference names cannot change. */
export const workflowPayloadQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  payloadRef: string | null,
) => ['workflows', runtimeIdentity, 'payload', runId, payloadRef] as const;

/**
 * One evidence listing.
 *
 * `signal` is the run's completed-capture count under the requested scope, not a clock: a list is
 * refetched exactly when a capture commits, and nothing else moves it. The filters are in the key
 * because a different filter set is a different listing, not a stale view of this one.
 */
export const workflowEvidenceListQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  scope: string,
  filters: string,
  signal: number,
) => ['workflows', runtimeIdentity, 'evidence', runId, scope, filters, signal] as const;

/** Immutable once written, like a payload: the bytes a reference names cannot change. */
export const workflowEvidenceContentQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  evidenceKey: string | null,
) => ['workflows', runtimeIdentity, 'evidence-content', runId, evidenceKey] as const;

/**
 * A run's checkpoint listing.
 *
 * `signal` is how many visits the run state says committed a checkpoint, so the list refetches
 * exactly when one is saved. Checkpoint rows are immutable, so nothing else moves it.
 */
export const workflowCheckpointListQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  signal: number,
) => ['workflows', runtimeIdentity, 'checkpoints', runId, signal] as const;

/** Immutable once written: a checkpoint's detail and inventory never change after capture. */
export const workflowCheckpointQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  checkpointId: string | null,
) => ['workflows', runtimeIdentity, 'checkpoint', runId, checkpointId] as const;

export const workflowCheckpointInventoryQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  checkpointId: string | null,
) => ['workflows', runtimeIdentity, 'checkpoint-inventory', runId, checkpointId] as const;

/** Immutable once written, like evidence content. */
export const workflowCheckpointFileContentQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  checkpointId: string | null,
  fileId: string | null,
) => ['workflows', runtimeIdentity, 'checkpoint-content', runId, checkpointId, fileId] as const;

/** One operation with its provenance, read on demand from an evidence record's source. */
export const workflowOperationQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  operationKey: string | null,
) => ['workflows', runtimeIdentity, 'operation', runId, operationKey] as const;
