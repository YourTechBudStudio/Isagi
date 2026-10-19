import { Schema } from 'effect';

import { fluidcastHandoffFailureSchema } from '../agent-sessions/types.js';
import { editorContextMetadataSchema } from '../editor/types.js';
import { sessionStatusSchema } from '../processes/types.js';
import {
  ptyStreamExitMessageSchema,
  ptyStreamOutputMessageSchema,
  ptyStreamReplayEndMessageSchema,
  ptyStreamReplayStartMessageSchema,
  ptyStreamTransportErrorCodeSchema,
} from '../pty-stream/types.js';
import { nonNegativeInteger, positiveInteger } from '../scalars.js';

/**
 * What is in a pane. This is the canonical declaration; `workspace/types.ts`
 * imports it rather than keeping a second copy.
 */
export const paneSessionKindSchema = Schema.Literals([
  'agent_session',
  'terminal_session',
  'editor_context',
]);
export const surfaceLayoutAxisSchema = Schema.Literals(['row', 'column']);
export const surfaceLayoutSizingSchema = Schema.Literals(['auto', 'manual']);

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
  nodeId: Schema.String.check(Schema.isMinLength(1)),
  paneId: positiveInteger,
  collapsed: Schema.Boolean,
});

export const surfaceLayoutNodeSchema: Schema.Codec<SurfaceLayoutNode> = Schema.suspend(() =>
  Schema.Union([
    surfaceLayoutLeafSchema,
    Schema.Struct({
      kind: Schema.Literal('split'),
      nodeId: Schema.String.check(Schema.isMinLength(1)),
      axis: surfaceLayoutAxisSchema,
      sizing: surfaceLayoutSizingSchema,
      children: Schema.Array(surfaceLayoutNodeSchema),
      weights: Schema.Array(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ]),
);

export const surfaceRouteParamsSchema = Schema.Struct({
  surfaceId: positiveInteger,
});

export const surfacePaneRouteParamsSchema = Schema.Struct({
  surfaceId: positiveInteger,
  paneId: positiveInteger,
});

export const worktreeEnvironmentFocusRouteParamsSchema = Schema.Struct({
  worktreeId: positiveInteger,
});

/**
 * The surface row already knows its worktree, but reordering names the parent
 * explicitly: the path is the trust boundary the runtime uses to reject a
 * cross-worktree move instead of quietly adopting the surface.
 */
export const worktreeSurfaceRouteParamsSchema = Schema.Struct({
  worktreeId: positiveInteger,
  surfaceId: positiveInteger,
});

export const moveSurfaceOrderInputSchema = Schema.Struct({
  beforeSurfaceId: Schema.NullOr(positiveInteger),
});

export const moveSurfaceOrderOutputSchema = Schema.Struct({
  worktreeId: positiveInteger,
  surfaceId: positiveInteger,
});

export const agentSessionRouteParamsSchema = Schema.Struct({
  agentSessionId: positiveInteger,
});

export const terminalSessionRouteParamsSchema = Schema.Struct({
  terminalSessionId: positiveInteger,
});

export const agentSessionStatusReasonSchema = Schema.Literals([
  'harness_launch_failed',
  'harness_process_exited',
  'harness_process_killed',
  'runtime_shutdown',
  'process_attach_failed',
  'harness_metadata_missing',
  'harness_metadata_invalid',
  'harness_resume_failed',
  'pty_process_missing',
  'pty_process_not_running',
  'agent_worker_failed',
]);

export const terminalSessionStatusReasonSchema = Schema.Literals([
  'shell_launch_failed',
  'shell_exited',
  'shell_killed',
  'runtime_shutdown',
  'process_attach_failed',
  'pty_process_missing',
  'pty_process_not_running',
]);

export const sessionDiagnosticCodeSchema = Schema.Literals([
  'harness_metadata_missing',
  'harness_metadata_invalid',
  'harness_resume_failed',
  'harness_launch_failed',
  'pty_process_launch_failed',
  'pty_process_attach_failed',
  'pty_process_missing',
  'pty_process_not_running',
]);

export const agentSessionRecoveryActionSchema = Schema.Literals([
  'connect_existing',
  'resume_existing',
  'relaunch_fresh',
  'create_replacement',
]);

export const ptyProcessBackendSchema = Schema.Literals(['tmux', 'node_pty']);
export const ptyProcessLogModeSchema = Schema.Literals(['backend_file', 'none']);
export const agentHarnessSchema = Schema.Literals(['pi', 'opencode', 'claude', 'codex']);

// The reasons the runtime refuses to create a harness process. This is the single
// canonical list; the PTY WebSocket error union, the session-launch rejection
// reason, and the control-plane launch projection all compose it so the set can
// never drift between the wire surfaces that carry it.
export const harnessLaunchBlockReasonSchema = Schema.Literals([
  'onboarding_incomplete',
  'config_invalid',
  'inventory_pending',
  'harness_disabled',
  'harness_missing',
  'harness_incompatible',
  'harness_probe_failed',
]);

/**
 * An opaque token naming one process incarnation of a durable session (ADR 0006). Clients compare
 * it for equality only: a terminal presentation is valid for exactly the incarnation it streams.
 */
const processIncarnationSchema = Schema.String.check(Schema.isMinLength(1));

const sessionProjectionFields = {
  status: sessionStatusSchema,
  /**
   * The session's live terminal process incarnation, or `null` when no terminal process is live
   * (none launched yet, the last one stopped, or an agent under Fluidcast). It changes whenever
   * the runtime replaces the process, which is when a client must re-attach.
   */
  processIncarnation: Schema.NullOr(processIncarnationSchema),
  diagnosticCode: Schema.NullOr(sessionDiagnosticCodeSchema),
  diagnosticDetail: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastSeenAt: Schema.NullOr(Schema.String),
} as const;

/**
 * `generation` increases on every change of the agent's interaction record and never repeats
 * within one runtime; a restart returns every agent to terminal mode at generation 0.
 * `fluidcast_failed` is a switch to Fluidcast that began cleanup but left no Fluidcast session
 * running.
 */
export const agentSessionInteractionSchema = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal('terminal'),
    generation: nonNegativeInteger,
    fluidcast: Schema.Literals(['available', 'unavailable']),
  }),
  Schema.Struct({
    mode: Schema.Literal('fluidcast'),
    generation: nonNegativeInteger,
    fluidcastSessionId: Schema.String,
  }),
  Schema.Struct({
    mode: Schema.Literal('fluidcast_failed'),
    generation: nonNegativeInteger,
    failure: fluidcastHandoffFailureSchema,
  }),
]);

export const agentSessionMetadataSchema = Schema.Struct({
  id: positiveInteger,
  paneId: positiveInteger,
  worktreeId: positiveInteger,
  harness: agentHarnessSchema,
  cwd: Schema.String,
  harnessSessionId: Schema.NullOr(Schema.String),
  statusReason: Schema.NullOr(agentSessionStatusReasonSchema),
  recoveryAction: agentSessionRecoveryActionSchema,
  /**
   * Which controller the agent is under. In terminal mode, `fluidcast` says whether a switch to
   * Fluidcast can be offered (the harness has an SDK worker and Fluidcast is configured); the
   * launch gate is still checked when the switch is made.
   */
  interaction: agentSessionInteractionSchema,
  ...sessionProjectionFields,
});

export const terminalSessionMetadataSchema = Schema.Struct({
  id: positiveInteger,
  paneId: positiveInteger,
  worktreeId: positiveInteger,
  cwd: Schema.String,
  shellCommand: Schema.String,
  shellArgs: Schema.Array(Schema.String),
  statusReason: Schema.NullOr(terminalSessionStatusReasonSchema),
  ...sessionProjectionFields,
});

export const surfacePaneSessionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('agent_session'),
    agentSession: agentSessionMetadataSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('terminal_session'),
    terminalSession: terminalSessionMetadataSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('editor_context'),
    editorContext: editorContextMetadataSchema,
  }),
]);

export const surfacePaneSchema = Schema.Struct({
  id: positiveInteger,
  surfaceId: positiveInteger,
  title: Schema.String,
  sortOrder: nonNegativeInteger,
  session: Schema.NullOr(surfacePaneSessionSchema),
});

export const surfaceDetailSchema = Schema.Struct({
  id: positiveInteger,
  worktreeId: positiveInteger,
  title: Schema.String,
  /**
   * Null exactly when the surface has no panes. An empty surface is a normal,
   * durable state: closing its last pane, or a workflow creating a surface
   * before its first agent starts, leaves the surface in place.
   */
  layout: Schema.NullOr(surfaceLayoutNodeSchema),
  activePaneId: Schema.NullOr(positiveInteger),
  panes: Schema.Array(surfacePaneSchema),
});

export const setWorktreeEnvironmentFocusInputSchema = Schema.Struct({
  activeSurfaceId: Schema.NullOr(positiveInteger),
  activePaneId: Schema.NullOr(positiveInteger),
});

export const createSurfaceOutputSchema = Schema.Struct({
  worktreeId: positiveInteger,
  surfaceId: positiveInteger,
  paneId: positiveInteger,
  title: Schema.String,
});

/**
 * What a caller may ask to be created in a pane, and deliberately narrower than
 * `paneSessionKindSchema`. An editor context is valid *projected* pane content
 * but is never generically creatable or claimable: it is a durable per-worktree
 * entity that the editor domain mints under its own lock, so a generic create,
 * split, or claim must not be able to bring one into existence. The same
 * asymmetry holds for `createSurfaceInputSchema`, `splitPaneInputSchema`,
 * `paneSessionCreateInputSchema`, and the claim schemas below.
 */
export const paneSessionSpecSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('agent_session'),
    harness: agentHarnessSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('terminal_session'),
  }),
]);

export const createSurfaceInputSchema = Schema.Struct({
  initialPane: paneSessionSpecSchema,
});

/** Starts the first pane of an empty surface. A surface that has panes is refused. */
export const startPaneInputSchema = Schema.Struct({
  newPane: paneSessionSpecSchema,
});

export const splitPaneDirectionSchema = Schema.Literals(['left', 'right', 'up', 'down']);

export const splitPaneInputSchema = Schema.Struct({
  paneId: positiveInteger,
  direction: splitPaneDirectionSchema,
  newPane: paneSessionSpecSchema,
});

export const setSplitWeightsInputSchema = Schema.Struct({
  nodeId: Schema.String.check(Schema.isMinLength(1)),
  weights: Schema.Array(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const setSplitWeightsOutputSchema = Schema.Struct({
  surfaceId: positiveInteger,
  layout: surfaceLayoutNodeSchema,
});

export const renameSurfaceInputSchema = Schema.Struct({
  title: Schema.String,
});

export const renameSurfaceOutputSchema = Schema.Struct({
  surfaceId: positiveInteger,
  title: Schema.String,
});

export const deleteSurfaceOutputSchema = Schema.Struct({
  deletedSurfaceId: Schema.NullOr(positiveInteger),
  deletedPaneIds: Schema.Array(positiveInteger),
});

/**
 * Deleting a pane never deletes its surface: removing the last pane leaves the
 * surface empty. Empty `deletedPaneIds` means the pane was already gone.
 */
export const deletePaneOutputSchema = Schema.Struct({
  deletedPaneIds: Schema.Array(positiveInteger),
});

export const worktreeEnvironmentFocusOutputSchema = Schema.Struct({
  worktreeId: positiveInteger,
  activeSurfaceId: Schema.NullOr(positiveInteger),
  activePaneId: Schema.NullOr(positiveInteger),
});

export const paneSessionCreateInputSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('agent_session'),
    paneId: positiveInteger,
    harness: agentHarnessSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('terminal_session'),
    paneId: positiveInteger,
  }),
]);

/**
 * Set only by an automatic re-attach: the claim, and the attach its token admits, may join only
 * this live incarnation and never launch a process. Anything else is refused with
 * `process_incarnation_stale`.
 */
const expectedProcessIncarnationField = Schema.optional(processIncarnationSchema);

export const paneSessionClaimInputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal('claim_agent_session'),
    paneId: positiveInteger,
    agentSessionId: positiveInteger,
    /**
     * The `interaction.generation` of the projection the claim was made from; a claim made under
     * an earlier controller is refused with `process_incarnation_stale`.
     */
    expectedInteractionGeneration: nonNegativeInteger,
    expectedProcessIncarnation: expectedProcessIncarnationField,
  }),
  Schema.Struct({
    action: Schema.Literal('claim_terminal_session'),
    paneId: positiveInteger,
    terminalSessionId: positiveInteger,
    expectedProcessIncarnation: expectedProcessIncarnationField,
  }),
]);

export const paneSessionClaimOutputSchema = Schema.Struct({
  worktreeId: positiveInteger,
  surfaceId: positiveInteger,
  paneId: positiveInteger,
  attachToken: Schema.String.check(Schema.isMinLength(1)),
  session: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('agent_session'),
      agentSessionId: positiveInteger,
    }),
    Schema.Struct({
      kind: Schema.Literal('terminal_session'),
      terminalSessionId: positiveInteger,
    }),
  ]),
});

export const ptyWebSocketInputMessageSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('input'),
    data: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('resize'),
    cols: positiveInteger,
    rows: positiveInteger,
  }),
]);

export const ptyWebSocketErrorCodeSchema = Schema.Union([
  ptyStreamTransportErrorCodeSchema,
  Schema.Literals([
    'invalid_session_id',
    'session_not_found',
    'session_not_running',
    'active_process_missing',
    'active_process_not_running',
    // An automatic re-attach named a process the session no longer runs; nothing was launched.
    'process_incarnation_stale',
    'harness_metadata_missing',
    'harness_metadata_invalid',
    'unsupported_harness',
    'session_already_attached',
    'session_attachment_moved',
    'attach_token_missing',
    'attach_token_invalid',
    'attach_token_expired',
    'pty_write_failed',
  ]),
  harnessLaunchBlockReasonSchema,
]);

export const ptyWebSocketErrorMessageSchema = Schema.Struct({
  type: Schema.Literal('error'),
  code: ptyWebSocketErrorCodeSchema,
  // Diagnostic detail for logs and support. Clients render copy keyed off `code`,
  // never this string. May be absent when there is nothing useful to add.
  message: Schema.optional(Schema.String),
});

export const ptyWebSocketOutputMessageSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('session'),
    status: sessionStatusSchema,
    /**
     * The process incarnation this stream is bound to, or `null` when it is bound to none.
     * Authoritative over the session projection, which can lag an attach that launched a process.
     */
    processIncarnation: Schema.NullOr(processIncarnationSchema),
    exitCode: Schema.optional(Schema.NullOr(nonNegativeInteger)),
    signal: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  ptyStreamReplayStartMessageSchema,
  ptyStreamOutputMessageSchema,
  ptyStreamReplayEndMessageSchema,
  ptyStreamExitMessageSchema,
  ptyWebSocketErrorMessageSchema,
]);

export type SurfaceRouteParams = typeof surfaceRouteParamsSchema.Type;
export type SurfacePaneRouteParams = typeof surfacePaneRouteParamsSchema.Type;
export type WorktreeEnvironmentFocusRouteParams =
  typeof worktreeEnvironmentFocusRouteParamsSchema.Type;
export type WorktreeSurfaceRouteParams = typeof worktreeSurfaceRouteParamsSchema.Type;
export type MoveSurfaceOrderInput = typeof moveSurfaceOrderInputSchema.Type;
export type MoveSurfaceOrderOutput = typeof moveSurfaceOrderOutputSchema.Type;
export type AgentSessionRouteParams = typeof agentSessionRouteParamsSchema.Type;
export type TerminalSessionRouteParams = typeof terminalSessionRouteParamsSchema.Type;
export type AgentSessionStatusReason = typeof agentSessionStatusReasonSchema.Type;
export type TerminalSessionStatusReason = typeof terminalSessionStatusReasonSchema.Type;
export type SessionDiagnosticCode = typeof sessionDiagnosticCodeSchema.Type;
export type AgentSessionRecoveryAction = typeof agentSessionRecoveryActionSchema.Type;
export type PtyProcessBackend = typeof ptyProcessBackendSchema.Type;
export type PtyProcessLogMode = typeof ptyProcessLogModeSchema.Type;
export type AgentHarness = typeof agentHarnessSchema.Type;
export type HarnessLaunchBlockReason = typeof harnessLaunchBlockReasonSchema.Type;
export type PaneSessionKind = typeof paneSessionKindSchema.Type;
export type AgentSessionMetadata = typeof agentSessionMetadataSchema.Type;
export type AgentSessionInteraction = typeof agentSessionInteractionSchema.Type;
export type TerminalSessionMetadata = typeof terminalSessionMetadataSchema.Type;
export type SurfacePaneSession = typeof surfacePaneSessionSchema.Type;
export type SurfacePane = typeof surfacePaneSchema.Type;
export type SurfaceDetail = typeof surfaceDetailSchema.Type;
export type SetWorktreeEnvironmentFocusInput = typeof setWorktreeEnvironmentFocusInputSchema.Type;
export type PaneSessionSpec = typeof paneSessionSpecSchema.Type;
export type CreateSurfaceInput = typeof createSurfaceInputSchema.Type;
export type CreateSurfaceOutput = typeof createSurfaceOutputSchema.Type;
export type SplitPaneDirection = typeof splitPaneDirectionSchema.Type;
export type SplitPaneInput = typeof splitPaneInputSchema.Type;
export type StartPaneInput = typeof startPaneInputSchema.Type;
export type SetSplitWeightsInput = typeof setSplitWeightsInputSchema.Type;
export type SetSplitWeightsOutput = typeof setSplitWeightsOutputSchema.Type;
export type RenameSurfaceInput = typeof renameSurfaceInputSchema.Type;
export type RenameSurfaceOutput = typeof renameSurfaceOutputSchema.Type;
export type DeleteSurfaceOutput = typeof deleteSurfaceOutputSchema.Type;
export type DeletePaneOutput = typeof deletePaneOutputSchema.Type;
export type WorktreeEnvironmentFocusOutput = typeof worktreeEnvironmentFocusOutputSchema.Type;
export type PaneSessionCreateInput = typeof paneSessionCreateInputSchema.Type;
export type PaneSessionClaimInput = typeof paneSessionClaimInputSchema.Type;
export type PaneSessionClaimOutput = typeof paneSessionClaimOutputSchema.Type;
export type PtyWebSocketInputMessage = typeof ptyWebSocketInputMessageSchema.Type;
export type PtyWebSocketOutputMessage = typeof ptyWebSocketOutputMessageSchema.Type;
export type PtyWebSocketErrorCode = typeof ptyWebSocketErrorCodeSchema.Type;
