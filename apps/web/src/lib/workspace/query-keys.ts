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
 * normalized runtime URL (`runtime-data.ts`). It is a namespace, not a fetch parameter: a run id is
 * only meaningful against the runtime that issued it.
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

/** One run with its tree of graph invocations and execution summaries. */
export const workflowRunQueryKey = (runtimeIdentity: string | null, runId: number | null) =>
  ['workflows', runtimeIdentity, 'run', runId] as const;

/** One run's whole event log, loaded forward and then appended from the socket. */
export const workflowEventsQueryKey = (runtimeIdentity: string | null, runId: number | null) =>
  ['workflows', runtimeIdentity, 'events', runId] as const;

/** One execution in full, with its operations. */
export const workflowExecutionQueryKey = (
  runtimeIdentity: string | null,
  executionId: number | null,
) => ['workflows', runtimeIdentity, 'execution', executionId] as const;

/** A verified build's structure. Immutable under its hash. */
export const workflowStructureQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
  artifactHash: string | null,
) => ['workflows', runtimeIdentity, 'structure', runId, artifactHash] as const;

export const workflowCheckpointListQueryKey = (
  runtimeIdentity: string | null,
  runId: number | null,
) => ['workflows', runtimeIdentity, 'checkpoints', runId] as const;

/** One checkpoint with every file it saved. Immutable once saved. */
export const workflowCheckpointQueryKey = (
  runtimeIdentity: string | null,
  checkpointId: number | null,
) => ['workflows', runtimeIdentity, 'checkpoint', checkpointId] as const;

export const workflowCheckpointFileQueryKey = (
  runtimeIdentity: string | null,
  checkpointId: number | null,
  path: string | null,
) => ['workflows', runtimeIdentity, 'checkpoint-file', checkpointId, path] as const;
