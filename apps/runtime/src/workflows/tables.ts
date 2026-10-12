import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import {
  workflowEventCategorySchema,
  workflowEventKindSchema,
  workflowExecutionStatusSchema,
  workflowGraphInvocationStatusSchema,
  workflowNodeKindSchema,
  workflowOperationKindSchema,
  workflowOperationStatusSchema,
  workflowRunStatusSchema,
} from '@isagi/contracts';

import { worktreeSurfaces } from '../environment/tables.js';

/*
 * Workflow records.
 *
 * Seven tables hold everything a run leaves behind. Each action inserts or updates the rows it owns
 * and appends event rows; nothing else is derived or cached here. JSON values are plain `*_json`
 * text columns. Children reference their run with `onDelete: 'cascade'`, so deleting a run removes
 * its whole history. Status columns reuse the contracts literal sets, so a status the API can
 * describe is exactly a status the database can hold.
 *
 * The links between the tables that point both ways (an invocation's parent execution, an
 * execution's child invocation, its checkpoint and the execution it retries) are plain integers
 * rather than foreign keys, so rows can be inserted in the order the engine creates them.
 */

/** One verified build of a workflow, by the hash of its artifact. Runs point at the build they use. */
export const workflowArtifacts = sqliteTable(
  'workflow_artifacts',
  {
    hash: text('hash').primaryKey(),
    workflowKey: text('workflow_key').notNull(),
    sdkVersion: text('sdk_version').notNull(),
    verifierVersion: text('verifier_version').notNull(),
    contractVersion: integer('contract_version').notNull(),
    structureJson: text('structure_json').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
  },
  (table) => [index('workflow_artifacts_key_idx').on(table.workflowKey)],
);

/** One launch of a workflow. */
export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /**
     * The project this run belongs to, set at launch and never changed. Run history survives deletion
     * of its surface or worktree, but not of its project: deleting a project erases its runs in the
     * same transaction through `WorkflowProjectErasure` (`workflows/erasure.ts`), and launch refuses to
     * insert a run once its project is gone. No foreign key, because a cascade from `projects` would
     * make the workspace's delete write workflow tables (ADR 0008). `projects.id` is AUTOINCREMENT,
     * so a dangling id never names a different project.
     */
    projectId: integer('project_id').notNull(),
    workflowKey: text('workflow_key').notNull(),
    title: text('title').notNull(),
    /** The build the run uses now. Resume and Retry move it to the latest verified build. */
    artifactHash: text('artifact_hash')
      .notNull()
      .references(() => workflowArtifacts.hash),
    status: text('status', { enum: workflowRunStatusSchema.literals }).notNull(),
    /** The raw launch answers, kept for display and relaunch. Nothing re-derives parameters from them. */
    inputsJson: text('inputs_json').notNull(),
    /** What the workflow's `parse` returned at launch: the root graph's parameters. */
    parametersJson: text('parameters_json').notNull(),
    /**
     * `{ source, request, baseCommit }`: the placement that was asked for, who decided it, and the
     * commit a `create` worktree's `fromRef` resolved to at launch. Preparation and Retry use
     * `baseCommit`, never the ref, so a moved ref cannot change where the run starts.
     */
    placementJson: text('placement_json').notNull(),
    /**
     * Where the run was launched from. Descriptive, with no foreign keys, so it survives the
     * deletion of what it names.
     */
    originWorktreeId: integer('origin_worktree_id').notNull(),
    originWorktreePath: text('origin_worktree_path').notNull(),
    originSurfaceId: integer('origin_surface_id'),
    originPaneId: integer('origin_pane_id'),
    originAgentSessionId: integer('origin_agent_session_id'),
    /**
     * Preparation writes these as each step finishes, and Retry skips whatever is already set.
     * The worktree is descriptive like the origin. The surface is the run's attachment: deleting
     * the surface releases it, and Dismiss clears it.
     */
    worktreeId: integer('worktree_id'),
    worktreePath: text('worktree_path'),
    setupDone: integer('setup_done', { mode: 'boolean' }).notNull().default(false),
    surfaceId: integer('surface_id').references(() => worktreeSurfaces.id, {
      onDelete: 'set null',
    }),
    /** `{ stage, message }` of the failure that stopped the run. */
    errorJson: text('error_json'),
    /** `{ outcomeId, kind, reason, output }` of the root graph. */
    outcomeJson: text('outcome_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    endedAt: text('ended_at'),
  },
  (table) => [
    index('workflow_runs_project_idx').on(table.projectId, table.id),
    index('workflow_runs_status_idx').on(table.status),
    index('workflow_runs_workflow_key_idx').on(table.workflowKey, table.id),
    index('workflow_runs_surface_idx').on(table.surfaceId),
  ],
);

/** One entry into a graph: the root graph once per run, and one per visit to a subgraph node. */
export const workflowGraphInvocations = sqliteTable(
  'workflow_graph_invocations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    /** The subgraph execution that entered this graph. Null for the root invocation. */
    parentExecutionId: integer('parent_execution_id'),
    graphKey: text('graph_key').notNull(),
    depth: integer('depth').notNull(),
    label: text('label'),
    parametersJson: text('parameters_json').notNull(),
    /** The current state. Each execution's `state_after_json` holds the history. */
    stateJson: text('state_json').notNull(),
    status: text('status', { enum: workflowGraphInvocationStatusSchema.literals }).notNull(),
    outcomeJson: text('outcome_json'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
  },
  (table) => [index('workflow_graph_invocations_run_idx').on(table.runId, table.id)],
);

/**
 * One run of one node. A Retry inserts a new row pointing at the one it retries and keeps its
 * `visit_index`, so visits are not unique.
 *
 * `result_json` is what the node function returned, including a suspend's wait. It is saved before
 * anything routes and is the only value ever reused. `event_json`, `decision_json` and
 * `state_after_json` record what came back, where the edge went and the invocation state after the
 * step.
 */
export const workflowExecutions = sqliteTable(
  'workflow_executions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    invocationId: integer('invocation_id')
      .notNull()
      .references(() => workflowGraphInvocations.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    nodeKind: text('node_kind', { enum: workflowNodeKindSchema.literals }).notNull(),
    visitIndex: integer('visit_index').notNull(),
    label: text('label'),
    /** The build that ran this execution. */
    artifactHash: text('artifact_hash')
      .notNull()
      .references(() => workflowArtifacts.hash),
    status: text('status', { enum: workflowExecutionStatusSchema.literals }).notNull(),
    retryOf: integer('retry_of'),
    resultJson: text('result_json'),
    eventJson: text('event_json'),
    decisionJson: text('decision_json'),
    stateAfterJson: text('state_after_json'),
    childInvocationId: integer('child_invocation_id'),
    checkpointId: integer('checkpoint_id'),
    /** `{ stage, message }`: which step failed and why. */
    errorJson: text('error_json'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
  },
  (table) => [
    index('workflow_executions_run_idx').on(table.runId, table.id),
    index('workflow_executions_invocation_idx').on(table.invocationId, table.id),
  ],
);

/**
 * The operation log: one row per side-effecting `ctx` call. History only; it is never consulted to
 * skip work. `seq` orders the calls within an execution.
 */
export const workflowOperations = sqliteTable(
  'workflow_operations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    executionId: integer('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: workflowOperationKindSchema.literals }).notNull(),
    /** Descriptive, with no foreign keys: the log outlives the session and pane it names. */
    agentSessionId: integer('agent_session_id'),
    paneId: integer('pane_id'),
    harness: text('harness'),
    model: text('model'),
    effort: text('effort'),
    requestJson: text('request_json').notNull(),
    status: text('status', { enum: workflowOperationStatusSchema.literals }).notNull(),
    /** The agent's last assistant text for the turn, or a headless run's output. */
    responseText: text('response_text'),
    resultJson: text('result_json'),
    harnessSessionId: text('harness_session_id'),
    usageJson: text('usage_json'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
  },
  (table) => [
    index('workflow_operations_run_idx').on(table.runId, table.id),
    index('workflow_operations_execution_idx').on(table.executionId, table.seq),
    index('workflow_operations_agent_session_idx').on(table.agentSessionId, table.id),
  ],
);

/** A run's append-only event log. The same rows are pushed live to clients. */
export const workflowEvents = sqliteTable(
  'workflow_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    executionId: integer('execution_id'),
    at: text('at').notNull(),
    category: text('category', { enum: workflowEventCategorySchema.literals }).notNull(),
    kind: text('kind', { enum: workflowEventKindSchema.literals }).notNull(),
    message: text('message').notNull(),
    dataJson: text('data_json'),
  },
  (table) => [index('workflow_events_run_idx').on(table.runId, table.id)],
);

/**
 * What one checkpoint execution saved: the HEAD commit (null for a folder project or an unborn
 * repository) and, in `scopes_json`, every captured scope with its files. The file bytes live in the
 * content store on disk, addressed by `sha256`.
 */
export const workflowCheckpoints = sqliteTable(
  'workflow_checkpoints',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    executionId: integer('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** The checkpoint node's static title, else its node id. */
    title: text('title').notNull(),
    /** The execution's captured dynamic label, when the node declares one that produced a name. */
    label: text('label'),
    commitSha: text('commit_sha'),
    scopesJson: text('scopes_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('workflow_checkpoints_run_idx').on(table.runId, table.id),
    index('workflow_checkpoints_execution_idx').on(table.executionId),
  ],
);
