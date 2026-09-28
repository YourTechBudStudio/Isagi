import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    // How this project's environments are maintained. Assigned once at
    // registration and never rewritten: reconciliation, restart, relocation and
    // recovery all read it and none of them reclassifies. The SQL default exists
    // so the upgrade can backfill historical rows, every one of which has
    // Git-validated provenance. Keep it: dropping it later would make
    // drizzle-kit emit a table rebuild to remove the constraint.
    kind: text('kind', { enum: ['git', 'folder'] })
      .notNull()
      .default('git'),
    status: text('status', { enum: ['present', 'missing'] }).notNull(),
    // Durable display rank among present sibling projects. Meaningless while a
    // project is missing: restoration always appends. See the rail reordering
    // plan; the value never leaves the repository.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastSeenAt: text('last_seen_at'),
    missingReason: text('missing_reason'),
  },
  (table) => [uniqueIndex('projects_root_path_unique').on(table.rootPath)],
);

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    branch: text('branch'),
    head: text('head'),
    // Durable display rank among the project's worktrees. The root worktree is
    // derived (path === project.rootPath) and pinned first at snapshot
    // composition, so its stored rank carries no meaning.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at'),
  },
  (table) => [uniqueIndex('worktrees_project_path_unique').on(table.projectId, table.path)],
);

export const worktreeSetupTrust = sqliteTable(
  'worktree_setup_trust',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['post_create'] }).notNull(),
    trustedHash: text('trusted_hash'),
    alwaysTrustProject: integer('always_trust_project', { mode: 'boolean' }).notNull(),
    hooksDisabled: integer('hooks_disabled', { mode: 'boolean' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('worktree_setup_trust_project_scope_unique').on(table.projectId, table.scope),
  ],
);

export const worktreeSetupRuns = sqliteTable('worktree_setup_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreeId: integer('worktree_id')
    .notNull()
    .references(() => worktrees.id, { onDelete: 'cascade' }),
  lifecycle: text('lifecycle', { enum: ['post_create'] }).notNull(),
  hookConfigHash: text('hook_config_hash').notNull(),
  status: text('status', { enum: ['succeeded', 'failed'] }).notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at').notNull(),
});

export const worktreeSetupSteps = sqliteTable('worktree_setup_steps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id')
    .notNull()
    .references(() => worktreeSetupRuns.id, { onDelete: 'cascade' }),
  hookIndex: integer('hook_index').notNull(),
  hookType: text('hook_type', { enum: ['copy', 'symlink', 'command'] }).notNull(),
  status: text('status', { enum: ['succeeded', 'failed', 'skipped'] }).notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at').notNull(),
  message: text('message'),
  command: text('command'),
  src: text('src'),
  dest: text('dest'),
  exitCode: integer('exit_code'),
  signal: text('signal'),
  outputExcerpt: text('output_excerpt'),
});

export const worktreeSurfaces = sqliteTable('worktree_surfaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreeId: integer('worktree_id')
    .notNull()
    .references(() => worktrees.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  layoutJson: text('layout_json').notNull(),
  sortOrder: integer('sort_order').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const surfacePanes = sqliteTable('surface_panes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  surfaceId: integer('surface_id')
    .notNull()
    .references(() => worktreeSurfaces.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull(),
  sessionKind: text('session_kind', {
    enum: ['agent_session', 'terminal_session', 'editor_context'],
  }),
  sessionId: integer('session_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const ptyProcesses = sqliteTable('pty_processes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  backend: text('backend', { enum: ['tmux', 'node_pty'] }).notNull(),
  backendRefJson: text('backend_ref_json').notNull(),
  command: text('command').notNull(),
  argsJson: text('args_json').notNull(),
  cwd: text('cwd').notNull(),
  status: text('status', {
    enum: ['starting', 'running', 'exited', 'failed', 'killed'],
  }).notNull(),
  statusReason: text('status_reason', {
    enum: [
      'user_requested',
      'runtime_shutdown',
      'backend_unavailable',
      'backend_process_missing',
      'backend_attach_failed',
      'backend_launch_failed',
      'runtime_ephemeral_lost',
    ],
  }),
  exitCode: integer('exit_code'),
  signal: text('signal'),
  logMode: text('log_mode', { enum: ['backend_file', 'none'] }).notNull(),
  logPath: text('log_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  exitedAt: text('exited_at'),
  lastSeenAt: text('last_seen_at'),
});

export const agentSessions = sqliteTable('agent_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreeId: integer('worktree_id')
    .notNull()
    .references(() => worktrees.id, { onDelete: 'cascade' }),
  harness: text('harness', { enum: ['pi', 'opencode', 'claude', 'codex'] }).notNull(),
  cwd: text('cwd').notNull(),
  activePtyProcessId: integer('active_pty_process_id').references(() => ptyProcesses.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastSeenAt: text('last_seen_at'),
});

export const terminalSessions = sqliteTable('terminal_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreeId: integer('worktree_id')
    .notNull()
    .references(() => worktrees.id, { onDelete: 'cascade' }),
  cwd: text('cwd').notNull(),
  shellCommand: text('shell_command').notNull(),
  shellArgsJson: text('shell_args_json').notNull(),
  activePtyProcessId: integer('active_pty_process_id').references(() => ptyProcesses.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const editorContexts = sqliteTable(
  'editor_contexts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    // The pointer to the replaceable incarnation (ADR 0006/0008). Cleared only in
    // the same transition that records an affirmatively terminated predecessor.
    activePtyProcessId: integer('active_pty_process_id').references(() => ptyProcesses.id),
    // What the runtime *chose* for this incarnation, written in the same durable
    // transition as the pointer. All three are null exactly when the pointer is.
    endpointHost: text('endpoint_host'),
    endpointPort: integer('endpoint_port'),
    sessionSocketPath: text('session_socket_path'),
    // The launch-attempt record. `in_progress` never coexists with a pointer;
    // that invariant is what makes boot's reading of it sound.
    attemptState: text('attempt_state', { enum: ['none', 'in_progress', 'failed'] }).notNull(),
    attemptReason: text('attempt_reason', {
      enum: [
        'port_allocation_failed',
        'session_socket_unavailable',
        'launch_allocation_failed',
        'launch_interrupted',
        'previous_incarnation_not_stopped',
        'launch_target_missing',
      ],
    }),
    attemptDetail: text('attempt_detail'),
    attemptStartedAt: text('attempt_started_at'),
    // Deliberately no `cwd` column, unlike `agent_sessions` and
    // `terminal_sessions`: the worktree's absolute path is re-resolved from the
    // `worktrees` row at every launch, so a relocated worktree can never be
    // launched into a stale directory. No `provider` column either — Code Server
    // is the only provider and the install path already names it.
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    // One editor context per worktree. The per-worktree lock serializes
    // find-and-place; this makes a duplicate impossible even if it did not.
    uniqueIndex('editor_contexts_worktree_id_unique').on(table.worktreeId),
    index('editor_contexts_active_pty_idx').on(table.activePtyProcessId),
  ],
);

export const worktreeCommandStates = sqliteTable(
  'worktree_command_states',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    commandName: text('command_name').notNull(),
    status: text('status', {
      enum: ['idle', 'running', 'exited', 'stopped', 'failed', 'suspended'],
    }).notNull(),
    activePtyProcessId: integer('active_pty_process_id').references(() => ptyProcesses.id),
    // The latest successfully established resolved-port snapshot, as JSON source
    // facts. Written only by the launch-in-progress marker, so a failed attempt
    // cannot destroy the memory of the last successful resolution. Null means no
    // launch has ever resolved ports for this command.
    resolvedPortsJson: text('resolved_ports_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('worktree_command_states_worktree_command_unique').on(
      table.worktreeId,
      table.commandName,
    ),
    index('worktree_command_states_active_pty_idx').on(table.activePtyProcessId),
  ],
);

export const worktreeCommandRuns = sqliteTable(
  'worktree_command_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    commandName: text('command_name').notNull(),
    ptyProcessId: integer('pty_process_id').references(() => ptyProcesses.id),
    status: text('status', { enum: ['running', 'exited', 'stopped', 'failed'] }).notNull(),
    diagnosticReason: text('diagnostic_reason', {
      enum: [
        'missing_cwd',
        'env_invalid',
        'pty_launch_failed',
        'port_allocation_failed',
        'runtime_stopped',
        'process_control_failed',
      ],
    }),
    diagnosticDetail: text('diagnostic_detail'),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('worktree_command_runs_latest_idx').on(table.worktreeId, table.commandName, table.id),
    index('worktree_command_runs_pty_idx').on(table.ptyProcessId),
  ],
);

export const worktreeEnvironmentStates = sqliteTable(
  'worktree_environment_states',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    activeSurfaceId: integer('active_surface_id').references(() => worktreeSurfaces.id, {
      onDelete: 'set null',
    }),
    activePaneId: integer('active_pane_id').references(() => surfacePanes.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('worktree_environment_states_worktree_id_unique').on(table.worktreeId)],
);

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
     * The project this run belongs to, set at launch and never changed. No foreign key: a run's
     * history outlives its project row, and project deletion erases runs through the workflow
     * domain. `projects.id` is AUTOINCREMENT, so a dangling id never names a different project.
     */
    projectId: integer('project_id').notNull(),
    workflowKey: text('workflow_key').notNull(),
    title: text('title').notNull(),
    /** The build the run uses now. Resume and Retry move it to the latest verified build. */
    artifactHash: text('artifact_hash')
      .notNull()
      .references(() => workflowArtifacts.hash),
    status: text('status', { enum: workflowRunStatusSchema.literals }).notNull(),
    inputsJson: text('inputs_json').notNull(),
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
    title: text('title').notNull(),
    commitSha: text('commit_sha'),
    scopesJson: text('scopes_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('workflow_checkpoints_run_idx').on(table.runId, table.id),
    index('workflow_checkpoints_execution_idx').on(table.executionId),
  ],
);
