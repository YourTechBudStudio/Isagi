import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

import {
  workflowAttemptStatusSchema,
  workflowCapabilitySchema,
  workflowEndCertaintySchema,
  workflowExecutionStatusSchema,
  workflowFailureCodeSchema,
  workflowFrameStatusSchema,
  workflowInvocationKindSchema,
  workflowNodeKindSchema,
  workflowOperationStageSchema,
  workflowOperationStateSchema,
  workflowOutcomeKindSchema,
  workflowRunStatusSchema,
  workflowSegmentKindSchema,
  workflowStopStateSchema,
  workflowTransitionKindSchema,
  workflowWaitKindSchema,
  workflowWaitStatusSchema,
} from '@isagi/contracts';

/**
 * Storage and wire share one vocabulary.
 *
 * Every enumerated workflow value below is the contracts literal set rather than a second hand-kept
 * copy, so a status the API can describe is exactly a status the database can hold. The read
 * projection maps identities (a row id to an opaque operation key, say); it never translates a
 * status name.
 */
const runStatuses = workflowRunStatusSchema.literals;
const frameStatuses = workflowFrameStatusSchema.literals;
const executionStatuses = workflowExecutionStatusSchema.literals;
const attemptStatuses = workflowAttemptStatusSchema.literals;
const segmentKinds = workflowSegmentKindSchema.literals;
const invocationKinds = workflowInvocationKindSchema.literals;
const endCertainties = workflowEndCertaintySchema.literals;
const transitionKinds = workflowTransitionKindSchema.literals;
const waitKinds = workflowWaitKindSchema.literals;
const waitStatuses = workflowWaitStatusSchema.literals;
const nodeKinds = workflowNodeKindSchema.literals;
const outcomeKinds = workflowOutcomeKindSchema.literals;
const failureCodes = workflowFailureCodeSchema.literals;
const capabilities = workflowCapabilitySchema.literals;
const operationStates = workflowOperationStateSchema.literals;
const operationStages = workflowOperationStageSchema.literals;
const stopStates = workflowStopStateSchema.literals;

/**
 * A recorded value lives in a *slot pair*: `<name>_inline` for canonical JSON at or under the inline
 * threshold, `<name>_ref` for a content-addressed reference to the payload store.
 *
 * The constraint is **at most one**, not exactly one, because both being null is the honest encoding
 * of a slot whose value was never produced. A recorded JSON `null` is the four bytes `null` in the
 * inline column, so "never produced" and "produced null" stay distinguishable. The repository
 * enforces the stronger per-site rule (a produced slot has exactly one member); this constraint is
 * what stops any writer that bypasses the repository from creating a row that is simultaneously
 * inline and referenced, which no reader could resolve.
 */
function payloadSlot(name: string, inline: AnySQLiteColumn, ref: AnySQLiteColumn) {
  return check(name, sql`${inline} IS NULL OR ${ref} IS NULL`);
}

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

export const surfacePanes = sqliteTable(
  'surface_panes',
  {
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
    /**
     * The caller-supplied intent key for a resource this call is creating, written by this owning
     * service and nobody else (ADR 0008). It exists so a crashed compound creation can be completed
     * rather than repeated: a re-entered keyed call finds what already exists under the same key and
     * resumes from there. Null for every ordinary, unkeyed creation, which is the common case.
     */
    creationKey: text('creation_key'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('surface_panes_creation_key_unique').on(table.creationKey)],
);

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

export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    harness: text('harness', { enum: ['pi', 'opencode', 'claude', 'codex'] }).notNull(),
    cwd: text('cwd').notNull(),
    activePtyProcessId: integer('active_pty_process_id').references(() => ptyProcesses.id),
    /**
     * The caller-supplied intent key for a resource this call is creating, written by this owning
     * service and nobody else (ADR 0008). It exists so a crashed compound creation can be completed
     * rather than repeated: a re-entered keyed call finds what already exists under the same key and
     * resumes from there. Null for every ordinary, unkeyed creation, which is the common case.
     */
    creationKey: text('creation_key'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastSeenAt: text('last_seen_at'),
  },
  (table) => [uniqueIndex('agent_sessions_creation_key_unique').on(table.creationKey)],
);

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
 * ---------------------------------------------------------------------------
 * Workflow execution records
 * ---------------------------------------------------------------------------
 *
 * These tables hold *retained history*: what a workflow run did, at every depth, across restarts
 * and across edited definitions. They are deliberately not worktree-environment state.
 *
 * The distinction decides the foreign keys. A worktree, a surface and a pane are replaceable
 * environment rows (ADR 0006) and may be deleted while a run's records must survive: a person who
 * deletes a worktree has not asked to erase the evidence of what ran in it. So `workflow_runs`
 * carries its origin and destination as plain descriptive columns with **no** foreign key, and the
 * one row whose lifetime really is the environment's — `workflow_run_attachments`, which is what
 * makes a run occupy a surface — is the only one that cascades. Deleting a worktree removes the
 * attachment and leaves the run, its frames, executions, attempts, transitions, operations and
 * payload references exactly as they were.
 *
 * #43 has no physical deletion path for any of this. Retention is indefinite and there is no TTL,
 * eviction or cleanup cap.
 */

/**
 * The retained catalog of definition versions.
 *
 * One row per artifact hash, kept forever and never rewritten. It is what lets the inspector read
 * the structure a past execution actually ran under without importing that old executable code:
 * `descriptor_*` holds the canonical structural descriptor as data.
 */
export const workflowArtifacts = sqliteTable(
  'workflow_artifacts',
  {
    artifactHash: text('artifact_hash').primaryKey(),
    workflowKey: text('workflow_key').notNull(),
    contractVersion: integer('contract_version').notNull(),
    manifestVersion: integer('manifest_version').notNull(),
    descriptorVersion: integer('descriptor_version').notNull(),
    sdkVersion: text('sdk_version').notNull(),
    verifierVersion: text('verifier_version').notNull(),
    sourceHash: text('source_hash').notNull(),
    structureHash: text('structure_hash').notNull(),
    rootGraphKey: text('root_graph_key').notNull(),
    descriptorInline: text('descriptor_inline'),
    descriptorRef: text('descriptor_ref'),
    firstSeenAt: text('first_seen_at').notNull(),
  },
  (table) => [
    index('workflow_artifacts_key_idx').on(table.workflowKey, table.firstSeenAt),
    payloadSlot('workflow_artifacts_descriptor_slot', table.descriptorInline, table.descriptorRef),
  ],
);

/**
 * Metadata for values too large to store inline.
 *
 * The bytes live in immutable content-addressed files under the runtime data root — never inside a
 * worktree, so deleting a project cannot take history with it. Rows are never deleted by #43; #45
 * replaces the storage implementation behind this reference without removing history.
 */
export const workflowPayloads = sqliteTable('workflow_payloads', {
  payloadRef: text('payload_ref').primaryKey(),
  byteSize: integer('byte_size').notNull(),
  mediaType: text('media_type').notNull(),
  createdAt: text('created_at').notNull(),
});

/** One root run. There are no child runs: nesting is frames within this run. */
export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Immutable launched key. Retry resolves the latest verified artifact for exactly this key. */
    workflowKey: text('workflow_key').notNull(),
    title: text('title').notNull(),
    rootGraphKey: text('root_graph_key').notNull(),
    /** The current pin. Uncommitted work always runs under this, never under a frame's entry pin. */
    artifactHash: text('artifact_hash')
      .notNull()
      .references(() => workflowArtifacts.artifactHash),
    status: text('status', { enum: runStatuses }).notNull(),
    outcomeId: text('outcome_id'),
    outcomeKind: text('outcome_kind', { enum: outcomeKinds }),
    outputInline: text('output_inline'),
    outputRef: text('output_ref'),
    /** Serialized `WorkflowRunPosition`: the one next segment. Decoded through the shared schema. */
    positionJson: text('position_json').notNull(),
    activeFrameId: integer('active_frame_id').references(
      (): AnySQLiteColumn => workflowGraphFrames.id,
      { onDelete: 'set null' },
    ),
    /**
     * Dispatch gates, orthogonal to `status`. A wait that resolves while a run is paused still
     * reaches `ready`; the gate stops the next claim rather than stranding the run at `waiting`.
     */
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    environmentAvailable: integer('environment_available', { mode: 'boolean' })
      .notNull()
      .default(true),
    /**
     * Not a pure dispatch gate: Cancel makes the run terminal, so the attempt-ownership commits and
     * wait delivery consult it to decide "advance the graph" versus "record evidence only".
     */
    cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
    /** Orders *prepared* actions — decisions computed from state read outside the transaction. */
    controlRevision: integer('control_revision').notNull().default(0),
    /** The history cursor, separate from `control_revision`; equals MAX(transition revision). */
    revision: integer('revision').notNull().default(0),
    /** The one attempt a claim owns. Cleared by every commit and by parking. */
    activeAttemptId: integer('active_attempt_id').references(
      (): AnySQLiteColumn => workflowSegmentAttempts.id,
      { onDelete: 'set null' },
    ),
    /**
     * Set by Retry adoption and consumed by the next claim. It survives a crash between adoption
     * and dispatch, which is what keeps an adopted Retry reported as `retry` rather than being
     * downgraded to `resumed` after a restart.
     */
    pendingInvocationKind: text('pending_invocation_kind', { enum: invocationKinds }),
    owner: text('owner'),
    ownerIncarnation: text('owner_incarnation'),
    failureCode: text('failure_code', { enum: failureCodes }),
    failureMessage: text('failure_message'),
    failureAttemptId: integer('failure_attempt_id').references(
      (): AnySQLiteColumn => workflowSegmentAttempts.id,
      { onDelete: 'set null' },
    ),
    blockedOperationId: integer('blocked_operation_id').references(
      (): AnySQLiteColumn => workflowOperations.id,
      { onDelete: 'set null' },
    ),
    /**
     * Immutable descriptive provenance with no foreign key, so it outlives the rows it names. This
     * is also how environment deletion finds affected runs: by the time a deletion notification is
     * published the attachment has already cascaded, so the lookup goes through these columns.
     */
    originWorktreeId: integer('origin_worktree_id'),
    originWorktreePath: text('origin_worktree_path'),
    originSurfaceId: integer('origin_surface_id'),
    originPaneId: integer('origin_pane_id'),
    originAgentSessionId: integer('origin_agent_session_id'),
    /** Equal to origin in #43; #44 changes only how a destination is chosen, not this shape. */
    destinationWorktreeId: integer('destination_worktree_id'),
    destinationWorktreePath: text('destination_worktree_path'),
    destinationSurfaceId: integer('destination_surface_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    endedAt: text('ended_at'),
  },
  (table) => [
    index('workflow_runs_status_idx').on(table.status),
    index('workflow_runs_dispatch_idx').on(table.status, table.paused),
    index('workflow_runs_key_idx').on(table.workflowKey, table.id),
    index('workflow_runs_created_idx').on(table.createdAt),
    index('workflow_runs_revision_idx').on(table.revision),
    index('workflow_runs_destination_worktree_idx').on(table.destinationWorktreeId),
    index('workflow_runs_destination_surface_idx').on(table.destinationSurfaceId),
    payloadSlot('workflow_runs_output_slot', table.outputInline, table.outputRef),
  ],
);

/**
 * The only environment-lifetime workflow row: it is what makes a run occupy a surface.
 *
 * Deleting the worktree cascades this away; deleting the surface nulls the pointer. Either way the
 * run's records are untouched — losing a place to show a run is not losing the run.
 */
export const workflowRunAttachments = sqliteTable(
  'workflow_run_attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    surfaceId: integer('surface_id').references(() => worktreeSurfaces.id, {
      onDelete: 'set null',
    }),
    attachedAt: text('attached_at').notNull(),
  },
  (table) => [
    uniqueIndex('workflow_run_attachments_run_unique').on(table.runId),
    /**
     * The surface-busy rule. Partial, so several detached runs can coexist. It holds for a terminal
     * run too: a finished run keeps its surface until the person dismisses it.
     */
    uniqueIndex('workflow_run_attachments_surface_unique')
      .on(table.surfaceId)
      .where(sql`${table.surfaceId} IS NOT NULL`),
    index('workflow_run_attachments_worktree_idx').on(table.worktreeId),
  ],
);

/** One invocation of a graph. A definition is reusable structure; a frame is one use of it. */
export const workflowGraphFrames = sqliteTable(
  'workflow_graph_frames',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    /** Null for the root frame. Otherwise the subgraph node execution that opened this frame. */
    parentExecutionId: integer('parent_execution_id').references(
      (): AnySQLiteColumn => workflowNodeExecutions.id,
      { onDelete: 'cascade' },
    ),
    graphKey: text('graph_key').notNull(),
    /**
     * Descriptive provenance — which pin was in force when this frame was entered — and never an
     * execution policy.
     */
    entryArtifactHash: text('entry_artifact_hash')
      .notNull()
      .references(() => workflowArtifacts.artifactHash),
    depth: integer('depth').notNull(),
    status: text('status', { enum: frameStatuses }).notNull(),
    /** Captured once when this record is created, then never recomputed. Cosmetic, never identity. */
    displayName: text('display_name'),
    /** The root frame's parameters are the launch inputs, stored here like any other frame's. */
    parametersInline: text('parameters_inline'),
    parametersRef: text('parameters_ref'),
    stateInline: text('state_inline'),
    stateRef: text('state_ref'),
    /**
     * The child's immutable completion fact. Once written these are the only source the parent's
     * mapping and router ever read, so editing child code and retrying the parent cannot recompute
     * them. `output_artifact_hash` is the pin that actually *produced* the value, which is not
     * necessarily the pin of the attempt that committed it.
     */
    outcomeId: text('outcome_id'),
    outcomeKind: text('outcome_kind', { enum: outcomeKinds }),
    outcomeReason: text('outcome_reason'),
    outputInline: text('output_inline'),
    outputRef: text('output_ref'),
    outputArtifactHash: text('output_artifact_hash').references(
      () => workflowArtifacts.artifactHash,
    ),
    enteredAt: text('entered_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('workflow_graph_frames_run_idx').on(table.runId, table.id),
    index('workflow_graph_frames_parent_idx').on(table.parentExecutionId),
    payloadSlot(
      'workflow_graph_frames_parameters_slot',
      table.parametersInline,
      table.parametersRef,
    ),
    payloadSlot('workflow_graph_frames_state_slot', table.stateInline, table.stateRef),
    payloadSlot('workflow_graph_frames_output_slot', table.outputInline, table.outputRef),
  ],
);

/**
 * One visit to a node.
 *
 * `visit_index` is the count of prior executions of this node id in this frame, so a first visit is
 * 0. A loop back to an earlier node creates a new execution rather than reopening the old one,
 * which is what keeps a definition node and an iteration of it from being conflated.
 */
export const workflowNodeExecutions = sqliteTable(
  'workflow_node_executions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    frameId: integer('frame_id')
      .notNull()
      .references((): AnySQLiteColumn => workflowGraphFrames.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    nodeKind: text('node_kind', { enum: nodeKinds }).notNull(),
    visitIndex: integer('visit_index').notNull(),
    status: text('status', { enum: executionStatuses }).notNull(),
    /** Set for a subgraph node: the child frame this visit opened and stays open across. */
    childFrameId: integer('child_frame_id').references(
      (): AnySQLiteColumn => workflowGraphFrames.id,
      { onDelete: 'set null' },
    ),
    displayName: text('display_name'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    /** An interval whose owner was interrupted keeps a null end and an unknown certainty. */
    endCertainty: text('end_certainty', { enum: endCertainties }).notNull(),
  },
  (table) => [
    index('workflow_node_executions_frame_idx').on(table.frameId, table.id),
    index('workflow_node_executions_run_idx').on(table.runId, table.id),
    uniqueIndex('workflow_node_executions_visit_unique').on(
      table.frameId,
      table.nodeId,
      table.visitIndex,
    ),
  ],
);

/**
 * One try at one segment.
 *
 * `producer_output_*` is the load-bearing recovery operand, not the failure code. Every attempt that
 * obtains a producer result — a validated callback result, an accepted edge decision, an evaluated
 * output, a mapping update — writes it here *before* attempting reduction, and nothing but a
 * successful commit ever ends the segment. A later attempt that finds one resumes at reduction, so
 * a reduction failure can never cause a successful callback or chooser to run again, no matter how
 * many retries or restarts intervene.
 *
 * `producer_artifact_hash` is the pin that produced that operand, carried forward unchanged when a
 * later attempt reuses it. It is deliberately distinct from this attempt's own `artifact_hash`: if
 * pin A evaluated a graph output and pin B committed it, the committed versioned fact must say A.
 */
export const workflowSegmentAttempts = sqliteTable(
  'workflow_segment_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    frameId: integer('frame_id')
      .notNull()
      .references((): AnySQLiteColumn => workflowGraphFrames.id, { onDelete: 'cascade' }),
    /** Null for `graph_entry` and `graph_output`: those segments belong to the frame, not a node. */
    executionId: integer('execution_id').references(
      (): AnySQLiteColumn => workflowNodeExecutions.id,
      { onDelete: 'cascade' },
    ),
    segmentKind: text('segment_kind', { enum: segmentKinds }).notNull(),
    /** The edge id or outcome id this segment is for; null where the segment kind needs neither. */
    segmentRef: text('segment_ref'),
    attemptIndex: integer('attempt_index').notNull(),
    /** The pin actually in force for this attempt. */
    artifactHash: text('artifact_hash')
      .notNull()
      .references(() => workflowArtifacts.artifactHash),
    status: text('status', { enum: attemptStatuses }).notNull(),
    invocationKind: text('invocation_kind', { enum: invocationKinds }).notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    endCertainty: text('end_certainty', { enum: endCertainties }).notNull(),
    failureCode: text('failure_code', { enum: failureCodes }),
    failureMessage: text('failure_message'),
    inputInline: text('input_inline'),
    inputRef: text('input_ref'),
    producerOutputInline: text('producer_output_inline'),
    producerOutputRef: text('producer_output_ref'),
    producerArtifactHash: text('producer_artifact_hash').references(
      () => workflowArtifacts.artifactHash,
    ),
    failureDetailInline: text('failure_detail_inline'),
    failureDetailRef: text('failure_detail_ref'),
  },
  (table) => [
    index('workflow_segment_attempts_execution_idx').on(table.executionId, table.id),
    index('workflow_segment_attempts_run_idx').on(table.runId, table.id),
    index('workflow_segment_attempts_segment_idx').on(table.frameId, table.segmentKind, table.id),
    payloadSlot('workflow_segment_attempts_input_slot', table.inputInline, table.inputRef),
    payloadSlot(
      'workflow_segment_attempts_producer_slot',
      table.producerOutputInline,
      table.producerOutputRef,
    ),
    payloadSlot(
      'workflow_segment_attempts_failure_detail_slot',
      table.failureDetailInline,
      table.failureDetailRef,
    ),
  ],
);

/**
 * The append-only history and the client stream spine.
 *
 * Every durable change allocates one row with its own contiguous per-run revision, including
 * diagnostics, receipt-stage advances and pause boundaries — so a diagnostic written just before a
 * callback failure survives that failure, and a client that has applied revision N can ask for
 * everything after N and miss nothing. A transaction that writes several transitions allocates
 * consecutive revisions and publishes all of them only after it commits.
 */
export const workflowTransitions = sqliteTable(
  'workflow_transitions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    recordedAt: text('recorded_at').notNull(),
    kind: text('kind', { enum: transitionKinds }).notNull(),
    frameId: integer('frame_id').references((): AnySQLiteColumn => workflowGraphFrames.id, {
      onDelete: 'cascade',
    }),
    executionId: integer('execution_id').references(
      (): AnySQLiteColumn => workflowNodeExecutions.id,
      { onDelete: 'cascade' },
    ),
    attemptId: integer('attempt_id').references((): AnySQLiteColumn => workflowSegmentAttempts.id, {
      onDelete: 'cascade',
    }),
    operationId: integer('operation_id').references((): AnySQLiteColumn => workflowOperations.id, {
      onDelete: 'cascade',
    }),
    waitId: integer('wait_id').references((): AnySQLiteColumn => workflowWaits.id, {
      onDelete: 'cascade',
    }),
    artifactHash: text('artifact_hash').references(() => workflowArtifacts.artifactHash),
    /** The post-transition frame state, where this transition committed one. */
    stateInline: text('state_inline'),
    stateRef: text('state_ref'),
    detailInline: text('detail_inline'),
    detailRef: text('detail_ref'),
  },
  (table) => [
    uniqueIndex('workflow_transitions_revision_unique').on(table.runId, table.revision),
    index('workflow_transitions_run_idx').on(table.runId, table.id),
    payloadSlot('workflow_transitions_state_slot', table.stateInline, table.stateRef),
    payloadSlot('workflow_transitions_detail_slot', table.detailInline, table.detailRef),
  ],
);

/**
 * What each committed revision changed, captured as it committed.
 *
 * The transition row says *that* something happened and to which identities; this table says what
 * the affected records looked like at that moment. It exists because current rows cannot reproduce
 * a historical delta: an execution mutates as its attempts, wait, routing and operations progress,
 * so projecting it now and attaching it to revision 40 would hand a reconnecting client a future
 * state under an old revision, and the REST replay of a delta would no longer equal the live event
 * the runtime already published.
 *
 * Written inside the same transaction as the transitions it describes, after that transaction's own
 * mutations, so a rollback leaves neither a transition nor a snapshot. Live publication and REST
 * recovery both decode these same rows — there is one durable delta representation, not two
 * algorithms that agree by hand.
 *
 * `record_json` holds the projected wire record, which is what both delivery paths need and what
 * makes the read model independent of later mutation. `summary` rows are written for **every**
 * revision, because a point-in-time run summary is what a baseline read at a frozen high-water
 * revision must return; `summary_changed` marks the ones a delta should actually carry, so an
 * unchanged summary does not ride along with every receipt update.
 *
 * Retention follows the rest of the model: these rows are history and are never evicted.
 */
export const workflowTransitionChanges = sqliteTable(
  'workflow_transition_changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    recordKind: text('record_kind', {
      enum: ['summary', 'frame', 'execution', 'operation'],
    }).notNull(),
    /** The changed record's row id. Zero for `summary`, which is the run itself. */
    recordId: integer('record_id').notNull(),
    recordJson: text('record_json').notNull(),
    /** Only meaningful for `summary`: whether this revision changed anything a client would show. */
    summaryChanged: integer('summary_changed', { mode: 'boolean' }),
  },
  (table) => [
    uniqueIndex('workflow_transition_changes_record_unique').on(
      table.runId,
      table.revision,
      table.recordKind,
      table.recordId,
    ),
    /** "What did revisions (n, h] change?" — the delta assembly scan. */
    index('workflow_transition_changes_revision_idx').on(table.runId, table.revision),
    /** "What did this record look like at or before revision h?" — every point-in-time read. */
    index('workflow_transition_changes_record_idx').on(
      table.runId,
      table.recordKind,
      table.recordId,
      table.revision,
    ),
  ],
);

/**
 * One armed wait.
 *
 * Delivery targets this row's id, so a stale form or an old turn cannot satisfy a later visit to the
 * same node. A superseded wait is retained with its late event rather than discarded.
 */
export const workflowWaits = sqliteTable(
  'workflow_waits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    executionId: integer('execution_id')
      .notNull()
      .references((): AnySQLiteColumn => workflowNodeExecutions.id, { onDelete: 'cascade' }),
    waitKind: text('wait_kind', { enum: waitKinds }).notNull(),
    conditionInline: text('condition_inline'),
    conditionRef: text('condition_ref'),
    status: text('status', { enum: waitStatuses }).notNull(),
    armedAt: text('armed_at').notNull(),
    deliveredAt: text('delivered_at'),
    consumedAt: text('consumed_at'),
    eventInline: text('event_inline'),
    eventRef: text('event_ref'),
  },
  (table) => [
    index('workflow_waits_run_status_idx').on(table.runId, table.status),
    index('workflow_waits_execution_idx').on(table.executionId),
    payloadSlot('workflow_waits_condition_slot', table.conditionInline, table.conditionRef),
    payloadSlot('workflow_waits_event_slot', table.eventInline, table.eventRef),
  ],
);

/**
 * One durable external operation.
 *
 * External effects are not exactly once, and this row is what makes recovery honest rather than
 * optimistic. `state` is the settlement; `stage` records how far a capability that crosses an
 * external boundary actually got, and every value naming a boundary is written **before** that
 * boundary is crossed. That is what separates a resource-only receipt from a submitted prompt, so
 * the generic "dispatched, return the receipt" rule can never report an unsent prompt as sent.
 *
 * `(execution_id, call_index)` is the durable call position. Re-entering an edited callback matches
 * recorded calls by that position and fingerprint: a matching prefix reuses receipts without
 * re-dispatching, a changed or omitted recorded call fails before a new effect is sent, and a new
 * visit to the node creates new positions and therefore new effects.
 */
export const workflowOperations = sqliteTable(
  'workflow_operations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The public opaque id (`wop_<uuid>`) and the cross-service creation-correlation key. */
    operationKey: text('operation_key').notNull(),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    frameId: integer('frame_id')
      .notNull()
      .references((): AnySQLiteColumn => workflowGraphFrames.id, { onDelete: 'cascade' }),
    /** Required: an operation is only ever created inside a node callback. */
    executionId: integer('execution_id')
      .notNull()
      .references((): AnySQLiteColumn => workflowNodeExecutions.id, { onDelete: 'cascade' }),
    originAttemptId: integer('origin_attempt_id')
      .notNull()
      .references((): AnySQLiteColumn => workflowSegmentAttempts.id, { onDelete: 'cascade' }),
    capability: text('capability', { enum: capabilities }).notNull(),
    callIndex: integer('call_index').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    requestInline: text('request_inline'),
    requestRef: text('request_ref'),
    artifactHash: text('artifact_hash')
      .notNull()
      .references(() => workflowArtifacts.artifactHash),
    state: text('state', { enum: operationStates }).notNull(),
    stage: text('stage', { enum: operationStages }),
    receiptInline: text('receipt_inline'),
    receiptRef: text('receipt_ref'),
    resultInline: text('result_inline'),
    resultRef: text('result_ref'),
    targetKind: text('target_kind', {
      enum: ['agent_session', 'pane', 'pty_process', 'none'],
    }).notNull(),
    targetId: integer('target_id'),
    /** Allocated before any process exists, so an interrupted launch still has a durable identity. */
    ptyProcessId: integer('pty_process_id'),
    /** The runtime incarnation capturing a headless process. Losing it is what `interrupted` means. */
    captureOwner: text('capture_owner'),
    attribution: text('attribution', {
      enum: ['not_applicable', 'inferred_by_watermark', 'ambiguous'],
    }).notNull(),
    correlatedStartSeq: integer('correlated_start_seq'),
    correlatedHarnessSessionId: text('correlated_harness_session_id'),
    /** The `sentAt` persisted *before* a PTY write, which is what bounds a recovery search. */
    submissionWatermark: text('submission_watermark'),
    stopState: text('stop_state', { enum: stopStates }).notNull(),
    stopDetail: text('stop_detail'),
    stopRequestedAt: text('stop_requested_at'),
    stopSettledAt: text('stop_settled_at'),
    uncertaintyDetail: text('uncertainty_detail'),
    lateEvidenceInline: text('late_evidence_inline'),
    lateEvidenceRef: text('late_evidence_ref'),
    createdAt: text('created_at').notNull(),
    dispatchedAt: text('dispatched_at'),
    settledAt: text('settled_at'),
  },
  (table) => [
    uniqueIndex('workflow_operations_key_unique').on(table.operationKey),
    uniqueIndex('workflow_operations_call_position_unique').on(table.executionId, table.callIndex),
    index('workflow_operations_run_state_idx').on(table.runId, table.state),
    index('workflow_operations_capture_owner_idx').on(table.captureOwner, table.state),
    index('workflow_operations_target_idx').on(table.targetKind, table.targetId),
    index('workflow_operations_pty_idx').on(table.ptyProcessId),
    payloadSlot('workflow_operations_request_slot', table.requestInline, table.requestRef),
    payloadSlot('workflow_operations_receipt_slot', table.receiptInline, table.receiptRef),
    payloadSlot('workflow_operations_result_slot', table.resultInline, table.resultRef),
    payloadSlot(
      'workflow_operations_late_evidence_slot',
      table.lateEvidenceInline,
      table.lateEvidenceRef,
    ),
  ],
);

/**
 * Which definition version a run adopted, and why.
 *
 * Only `launch` and `retry` can adopt. Resume deliberately cannot: it loads the run's *current* pin,
 * never discovery and never a newer artifact, so there is no such thing as a resume adoption.
 */
export const workflowVersionAdoptions = sqliteTable(
  'workflow_version_adoptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    artifactHash: text('artifact_hash')
      .notNull()
      .references(() => workflowArtifacts.artifactHash),
    reason: text('reason', { enum: ['launch', 'retry'] }).notNull(),
    attemptId: integer('attempt_id').references((): AnySQLiteColumn => workflowSegmentAttempts.id, {
      onDelete: 'set null',
    }),
    adoptedAt: text('adopted_at').notNull(),
  },
  (table) => [index('workflow_version_adoptions_run_idx').on(table.runId, table.id)],
);

/**
 * Observed pause boundaries.
 *
 * Pause time is derived by intersecting these intervals with an execution's or attempt's own
 * interval, so a pause that overlaps an external wait is distinguishable rather than additive. An
 * interval is stored, never counted: there is at most one open interval per run.
 */
export const workflowPauseIntervals = sqliteTable(
  'workflow_pause_intervals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    /** Why the run stopped dispatching. A restart is not an operator action and does not claim to be. */
    reason: text('reason', {
      enum: ['control', 'environment_deleted', 'runtime_restart'],
    }).notNull(),
    pausedAt: text('paused_at').notNull(),
    resumedAt: text('resumed_at'),
  },
  (table) => [
    index('workflow_pause_intervals_run_idx').on(table.runId, table.id),
    /** At most one open interval per run, so repeated Pause or parking cannot duplicate a band. */
    uniqueIndex('workflow_pause_intervals_open_unique')
      .on(table.runId)
      .where(sql`${table.resumedAt} IS NULL`),
  ],
);
