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

/** Immutable once written, like a descriptor: the bytes a reference names cannot change. */
export const workflowPayloadQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  payloadRef: string | null,
) => ['workflows', runtimeIdentity, 'payload', runId, payloadRef] as const;
