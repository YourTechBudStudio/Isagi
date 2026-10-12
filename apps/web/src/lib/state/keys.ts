/**
 * The Reactivity key catalog: which runtime facts an invalidation refreshes.
 *
 * Keys are flat strings and nothing else. `Reactivity` hashes array elements one by one, but it
 * registers a record key such as `{ surface: [12] }` under both `surface` and `surface:12`, so
 * invalidating `{ surface: [13] }` would refresh every surface. A flat string is exact: invalidating
 * `surface:13` touches surface 13 only, and `workspace` does not touch `active-context`.
 */
export const keys = {
  workspace: 'workspace',
  activeContext: 'active-context',
  surface: (surfaceId: number) => `surface:${surfaceId}`,
  commands: (worktreeId: number) => `commands:${worktreeId}`,
  commandLog: (worktreeId: number, commandName: string) =>
    `command-log:${worktreeId}:${commandName}`,
  controlPlane: 'control-plane',
  clientSettings: 'client-settings',
  workflowLive: 'workflow:live',
  workflowRun: (runId: number) => `workflow:run:${runId}`,
  workflowEvents: (runId: number) => `workflow:events:${runId}`,
  workflowExecution: (executionId: number) => `workflow:execution:${executionId}`,
  workflowCheckpoints: (runId: number) => `workflow:checkpoints:${runId}`,
} as const;
