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

export const worktreeEnvironmentFocusRouteParamsSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
});

export const ptySessionRouteParamsSchema = Schema.Struct({
  ptySessionId: positiveIntegerSchema,
});

export const ptySessionStatusSchema = Schema.Literal('starting', 'running', 'exited', 'failed');
export const ptySessionAdapterSchema = Schema.Literal('node_pty');
export const ptySessionPurposeSchema = Schema.Literal('agent', 'terminal');
export const agentHarnessSchema = Schema.Literal('pi', 'opencode', 'claude', 'codex');

export const ptySessionMetadataSchema = Schema.Struct({
  id: positiveIntegerSchema,
  paneId: positiveIntegerSchema,
  worktreeId: positiveIntegerSchema,
  adapter: ptySessionAdapterSchema,
  purpose: ptySessionPurposeSchema,
  harness: Schema.NullOr(agentHarnessSchema),
  command: Schema.String,
  cwd: Schema.String,
  status: ptySessionStatusSchema,
  exitCode: Schema.NullOr(nonNegativeIntegerSchema),
  signal: Schema.NullOr(Schema.String),
  logBytes: nonNegativeIntegerSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  exitedAt: Schema.NullOr(Schema.String),
});

export const surfacePaneSchema = Schema.Struct({
  id: positiveIntegerSchema,
  surfaceId: positiveIntegerSchema,
  title: Schema.String,
  attention: Schema.Literal('idle', 'working', 'waiting', 'error'),
  sortOrder: nonNegativeIntegerSchema,
  ptySession: Schema.NullOr(ptySessionMetadataSchema),
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

export const worktreeEnvironmentFocusOutputSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
  activeSurfaceId: Schema.NullOr(positiveIntegerSchema),
  activePaneId: Schema.NullOr(positiveIntegerSchema),
});

export const launchAgentSessionInputSchema = Schema.Struct({
  harness: agentHarnessSchema,
});

export const launchSessionOutputSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
  surfaceId: positiveIntegerSchema,
  paneId: positiveIntegerSchema,
  ptySessionId: positiveIntegerSchema,
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
  'log_read_failed',
  'worktree_not_found',
  'pty_write_failed',
  'pty_state_load_failed',
  'unknown',
);

export const ptyWebSocketOutputMessageSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('session'),
    status: ptySessionStatusSchema,
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
export type WorktreeEnvironmentFocusRouteParams = Schema.Schema.Type<
  typeof worktreeEnvironmentFocusRouteParamsSchema
>;
export type PtySessionRouteParams = Schema.Schema.Type<typeof ptySessionRouteParamsSchema>;
export type PtySessionStatus = Schema.Schema.Type<typeof ptySessionStatusSchema>;
export type PtySessionAdapter = Schema.Schema.Type<typeof ptySessionAdapterSchema>;
export type PtySessionPurpose = Schema.Schema.Type<typeof ptySessionPurposeSchema>;
export type AgentHarness = Schema.Schema.Type<typeof agentHarnessSchema>;
export type PtySessionMetadata = Schema.Schema.Type<typeof ptySessionMetadataSchema>;
export type SurfacePane = Schema.Schema.Type<typeof surfacePaneSchema>;
export type SurfaceDetail = Schema.Schema.Type<typeof surfaceDetailSchema>;
export type SetWorktreeEnvironmentFocusInput = Schema.Schema.Type<
  typeof setWorktreeEnvironmentFocusInputSchema
>;
export type WorktreeEnvironmentFocusOutput = Schema.Schema.Type<
  typeof worktreeEnvironmentFocusOutputSchema
>;
export type LaunchAgentSessionInput = Schema.Schema.Type<typeof launchAgentSessionInputSchema>;
export type LaunchSessionOutput = Schema.Schema.Type<typeof launchSessionOutputSchema>;
export type PtyWebSocketInputMessage = Schema.Schema.Type<typeof ptyWebSocketInputMessageSchema>;
export type PtyWebSocketOutputMessage = Schema.Schema.Type<typeof ptyWebSocketOutputMessageSchema>;
export type PtyWebSocketErrorCode = Schema.Schema.Type<typeof ptyWebSocketErrorCodeSchema>;
