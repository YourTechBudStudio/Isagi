import { Schema } from 'effect';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());
const nonNegativeIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

export const runtimeSurfaceKindSchema = Schema.Literal('agent', 'terminal');
export const surfaceLayoutAxisSchema = Schema.Literal('row', 'column');
export const surfaceLayoutSizingSchema = Schema.Literal('auto', 'manual');

export interface SurfaceLayoutLeaf {
  readonly kind: 'leaf';
  readonly nodeId: string;
  readonly paneId: number;
  readonly collapsed: boolean;
}

export interface SurfaceLayoutSplit {
  readonly kind: 'split';
  readonly nodeId: string;
  readonly axis: 'row' | 'column';
  readonly sizing: 'auto' | 'manual';
  readonly children: readonly SurfaceLayoutNode[];
  readonly weights: readonly number[];
}

export type SurfaceLayoutNode = SurfaceLayoutLeaf | SurfaceLayoutSplit;

const surfaceLayoutLeafSchema = Schema.Struct({
  kind: Schema.Literal('leaf'),
  nodeId: Schema.String.pipe(Schema.minLength(1)),
  paneId: positiveIntegerSchema,
  collapsed: Schema.Boolean,
});

export const surfaceLayoutNodeSchema: Schema.Schema<SurfaceLayoutNode> = Schema.suspend(() =>
  Schema.Union(
    surfaceLayoutLeafSchema,
    Schema.Struct({
      kind: Schema.Literal('split'),
      nodeId: Schema.String.pipe(Schema.minLength(1)),
      axis: surfaceLayoutAxisSchema,
      sizing: surfaceLayoutSizingSchema,
      children: Schema.Array(surfaceLayoutNodeSchema),
      weights: Schema.Array(Schema.Number.pipe(Schema.nonNegative())),
    }),
  ),
);

export const surfaceRouteParamsSchema = Schema.Struct({
  surfaceId: positiveIntegerSchema,
});

export const surfacePaneRouteParamsSchema = Schema.Struct({
  surfaceId: positiveIntegerSchema,
  paneId: positiveIntegerSchema,
});

export const worktreeEnvironmentFocusRouteParamsSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
});

export const agentSessionRouteParamsSchema = Schema.Struct({
  agentSessionId: positiveIntegerSchema,
});

export const terminalSessionRouteParamsSchema = Schema.Struct({
  terminalSessionId: positiveIntegerSchema,
});

export const sessionStatusSchema = Schema.Literal(
  'starting',
  'running',
  'exited',
  'failed',
  'killed',
);

export const agentSessionStatusReasonSchema = Schema.Literal(
  'harness_launch_failed',
  'harness_process_exited',
  'harness_process_killed',
  'runtime_shutdown',
  'process_attach_failed',
  'harness_session_id_missing',
  'harness_metadata_invalid',
  'harness_resume_failed',
  'pty_process_missing',
  'pty_process_not_running',
);

export const terminalSessionStatusReasonSchema = Schema.Literal(
  'shell_launch_failed',
  'shell_exited',
  'shell_killed',
  'runtime_shutdown',
  'process_attach_failed',
  'pty_process_missing',
  'pty_process_not_running',
);

export const sessionDiagnosticCodeSchema = Schema.Literal(
  'harness_session_id_missing',
  'harness_metadata_invalid',
  'harness_resume_failed',
  'harness_launch_failed',
  'pty_process_launch_failed',
  'pty_process_attach_failed',
  'pty_process_missing',
  'pty_process_not_running',
);

export const agentSessionRecoveryActionSchema = Schema.Literal(
  'connect_existing',
  'resume_existing',
  'create_replacement',
);

export const ptyProcessBackendSchema = Schema.Literal('tmux', 'node_pty');
export const ptyProcessLogModeSchema = Schema.Literal('backend_file', 'none');
export const agentHarnessSchema = Schema.Literal('pi', 'opencode', 'claude', 'codex');

const sessionProjectionFields = {
  status: sessionStatusSchema,
  diagnosticCode: Schema.NullOr(sessionDiagnosticCodeSchema),
  diagnosticDetail: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastSeenAt: Schema.NullOr(Schema.String),
} as const;

export const agentSessionMetadataSchema = Schema.Struct({
  id: positiveIntegerSchema,
  paneId: positiveIntegerSchema,
  worktreeId: positiveIntegerSchema,
  harness: agentHarnessSchema,
  cwd: Schema.String,
  harnessSessionId: Schema.NullOr(Schema.String),
  statusReason: Schema.NullOr(agentSessionStatusReasonSchema),
  recoveryAction: agentSessionRecoveryActionSchema,
  ...sessionProjectionFields,
});

export const terminalSessionMetadataSchema = Schema.Struct({
  id: positiveIntegerSchema,
  paneId: positiveIntegerSchema,
  worktreeId: positiveIntegerSchema,
  cwd: Schema.String,
  shellCommand: Schema.String,
  shellArgs: Schema.Array(Schema.String),
  statusReason: Schema.NullOr(terminalSessionStatusReasonSchema),
  ...sessionProjectionFields,
});

export const surfacePaneSessionSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('agent_session'),
    agentSession: agentSessionMetadataSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('terminal_session'),
    terminalSession: terminalSessionMetadataSchema,
  }),
);

export const surfacePaneSchema = Schema.Struct({
  id: positiveIntegerSchema,
  surfaceId: positiveIntegerSchema,
  title: Schema.String,
  attention: Schema.Literal('idle', 'working', 'waiting', 'error'),
  sortOrder: nonNegativeIntegerSchema,
  session: Schema.NullOr(surfacePaneSessionSchema),
});

export const surfaceDetailSchema = Schema.Struct({
  id: positiveIntegerSchema,
  worktreeId: positiveIntegerSchema,
  kind: runtimeSurfaceKindSchema,
  title: Schema.String,
  attention: Schema.Literal('idle', 'working', 'waiting', 'error'),
  layout: surfaceLayoutNodeSchema,
  activePaneId: Schema.NullOr(positiveIntegerSchema),
  panes: Schema.Array(surfacePaneSchema),
});

export const setWorktreeEnvironmentFocusInputSchema = Schema.Struct({
  activeSurfaceId: Schema.NullOr(positiveIntegerSchema),
  activePaneId: Schema.NullOr(positiveIntegerSchema),
});

export const createSurfaceInputSchema = Schema.Struct({
  kind: runtimeSurfaceKindSchema,
});

export const createSurfaceOutputSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
  surfaceId: positiveIntegerSchema,
  paneId: positiveIntegerSchema,
  title: Schema.String,
});

export const launchAgentSurfaceInputSchema = Schema.Struct({
  harness: agentHarnessSchema,
});

export const renameSurfaceInputSchema = Schema.Struct({
  title: Schema.String,
});

export const renameSurfaceOutputSchema = Schema.Struct({
  surfaceId: positiveIntegerSchema,
  title: Schema.String,
});

export const surfaceSessionCleanupTargetSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('agent_session'),
    agentSessionId: positiveIntegerSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('terminal_session'),
    terminalSessionId: positiveIntegerSchema,
  }),
);

export const surfaceDeleteWarningSchema = Schema.Struct({
  code: Schema.Literal('session_process_cleanup_failed', 'session_log_delete_failed'),
  paneId: positiveIntegerSchema,
  session: surfaceSessionCleanupTargetSchema,
});

export const deleteSurfaceOutputSchema = Schema.Struct({
  deletedSurfaceId: Schema.NullOr(positiveIntegerSchema),
  deletedPaneIds: Schema.Array(positiveIntegerSchema),
  attemptedSessionIds: Schema.Array(surfaceSessionCleanupTargetSchema),
  warnings: Schema.Array(surfaceDeleteWarningSchema),
});

export const worktreeEnvironmentFocusOutputSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
  activeSurfaceId: Schema.NullOr(positiveIntegerSchema),
  activePaneId: Schema.NullOr(positiveIntegerSchema),
});

export const paneSessionCreateInputSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('agent_session'),
    paneId: positiveIntegerSchema,
    harness: agentHarnessSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('terminal_session'),
    paneId: positiveIntegerSchema,
  }),
);

export const paneSessionClaimInputSchema = Schema.Union(
  Schema.Struct({
    action: Schema.Literal('claim_agent_session'),
    paneId: positiveIntegerSchema,
    agentSessionId: positiveIntegerSchema,
  }),
  Schema.Struct({
    action: Schema.Literal('claim_terminal_session'),
    paneId: positiveIntegerSchema,
    terminalSessionId: positiveIntegerSchema,
  }),
);

export const paneSessionClaimOutputSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
  surfaceId: positiveIntegerSchema,
  paneId: positiveIntegerSchema,
  attachToken: Schema.String.pipe(Schema.minLength(1)),
  session: Schema.Union(
    Schema.Struct({
      kind: Schema.Literal('agent_session'),
      agentSessionId: positiveIntegerSchema,
    }),
    Schema.Struct({
      kind: Schema.Literal('terminal_session'),
      terminalSessionId: positiveIntegerSchema,
    }),
  ),
});

export const ptyWebSocketInputMessageSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('input'),
    data: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('resize'),
    cols: positiveIntegerSchema,
    rows: positiveIntegerSchema,
  }),
);

export const ptyWebSocketErrorCodeSchema = Schema.Literal(
  'invalid_session_id',
  'invalid_message',
  'session_not_found',
  'session_not_running',
  'active_process_missing',
  'active_process_not_running',
  'harness_session_id_missing',
  'unsupported_harness',
  'session_already_attached',
  'session_attachment_moved',
  'attach_token_missing',
  'attach_token_invalid',
  'attach_token_expired',
  'log_read_failed',
  'worktree_not_found',
  'backend_unavailable',
  'backend_session_missing',
  'backend_attach_failed',
  'pty_write_failed',
  'pty_state_load_failed',
  'unknown',
);

export const ptyWebSocketOutputMessageSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('session'),
    status: sessionStatusSchema,
    exitCode: Schema.optional(Schema.NullOr(nonNegativeIntegerSchema)),
    signal: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal('replay_start'),
    bytes: nonNegativeIntegerSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('output'),
    data: Schema.String,
    replay: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal('replay_end'),
  }),
  Schema.Struct({
    type: Schema.Literal('exit'),
    exitCode: Schema.NullOr(nonNegativeIntegerSchema),
    signal: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('error'),
    code: ptyWebSocketErrorCodeSchema,
    // Diagnostic detail for logs and support. Clients render copy keyed off `code`,
    // never this string. May be absent when there is nothing useful to add.
    message: Schema.optional(Schema.String),
  }),
);

export type RuntimeSurfaceKind = Schema.Schema.Type<typeof runtimeSurfaceKindSchema>;
export type SurfaceRouteParams = Schema.Schema.Type<typeof surfaceRouteParamsSchema>;
export type SurfacePaneRouteParams = Schema.Schema.Type<typeof surfacePaneRouteParamsSchema>;
export type WorktreeEnvironmentFocusRouteParams = Schema.Schema.Type<
  typeof worktreeEnvironmentFocusRouteParamsSchema
>;
export type AgentSessionRouteParams = Schema.Schema.Type<typeof agentSessionRouteParamsSchema>;
export type TerminalSessionRouteParams = Schema.Schema.Type<
  typeof terminalSessionRouteParamsSchema
>;
export type SessionStatus = Schema.Schema.Type<typeof sessionStatusSchema>;
export type AgentSessionStatusReason = Schema.Schema.Type<typeof agentSessionStatusReasonSchema>;
export type TerminalSessionStatusReason = Schema.Schema.Type<
  typeof terminalSessionStatusReasonSchema
>;
export type SessionDiagnosticCode = Schema.Schema.Type<typeof sessionDiagnosticCodeSchema>;
export type AgentSessionRecoveryAction = Schema.Schema.Type<
  typeof agentSessionRecoveryActionSchema
>;
export type PtyProcessBackend = Schema.Schema.Type<typeof ptyProcessBackendSchema>;
export type PtyProcessLogMode = Schema.Schema.Type<typeof ptyProcessLogModeSchema>;
export type AgentHarness = Schema.Schema.Type<typeof agentHarnessSchema>;
export type AgentSessionMetadata = Schema.Schema.Type<typeof agentSessionMetadataSchema>;
export type TerminalSessionMetadata = Schema.Schema.Type<typeof terminalSessionMetadataSchema>;
export type SurfacePaneSession = Schema.Schema.Type<typeof surfacePaneSessionSchema>;
export type SurfacePane = Schema.Schema.Type<typeof surfacePaneSchema>;
export type SurfaceDetail = Schema.Schema.Type<typeof surfaceDetailSchema>;
export type SetWorktreeEnvironmentFocusInput = Schema.Schema.Type<
  typeof setWorktreeEnvironmentFocusInputSchema
>;
export type CreateSurfaceInput = Schema.Schema.Type<typeof createSurfaceInputSchema>;
export type CreateSurfaceOutput = Schema.Schema.Type<typeof createSurfaceOutputSchema>;
export type LaunchAgentSurfaceInput = Schema.Schema.Type<typeof launchAgentSurfaceInputSchema>;
export type RenameSurfaceInput = Schema.Schema.Type<typeof renameSurfaceInputSchema>;
export type RenameSurfaceOutput = Schema.Schema.Type<typeof renameSurfaceOutputSchema>;
export type SurfaceSessionCleanupTarget = Schema.Schema.Type<
  typeof surfaceSessionCleanupTargetSchema
>;
export type SurfaceDeleteWarning = Schema.Schema.Type<typeof surfaceDeleteWarningSchema>;
export type DeleteSurfaceOutput = Schema.Schema.Type<typeof deleteSurfaceOutputSchema>;
export type WorktreeEnvironmentFocusOutput = Schema.Schema.Type<
  typeof worktreeEnvironmentFocusOutputSchema
>;
export type PaneSessionCreateInput = Schema.Schema.Type<typeof paneSessionCreateInputSchema>;
export type PaneSessionClaimInput = Schema.Schema.Type<typeof paneSessionClaimInputSchema>;
export type PaneSessionClaimOutput = Schema.Schema.Type<typeof paneSessionClaimOutputSchema>;
export type PtyWebSocketInputMessage = Schema.Schema.Type<typeof ptyWebSocketInputMessageSchema>;
export type PtyWebSocketOutputMessage = Schema.Schema.Type<typeof ptyWebSocketOutputMessageSchema>;
export type PtyWebSocketErrorCode = Schema.Schema.Type<typeof ptyWebSocketErrorCodeSchema>;
