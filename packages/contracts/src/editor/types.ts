import { Schema } from 'effect';

import { sessionStatusSchema } from '../processes/types.js';
import { positiveInteger } from '../scalars.js';

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export const editorProvisioningFailureReasonSchema = Schema.Literals([
  'unsupported_platform',
  'release_unavailable',
  'download_failed',
  'integrity_mismatch',
  'extract_failed',
  'install_unusable',
]);

/**
 * `checking | downloading | verifying | extracting` are the transient states the
 * startup gate polls on; `ready` and `failed` are settled.
 */
export const editorProvisioningStateSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(['checking', 'downloading', 'verifying', 'extracting']),
    version: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal('ready'), version: Schema.String }),
  Schema.Struct({
    status: Schema.Literal('failed'),
    version: Schema.String,
    reason: editorProvisioningFailureReasonSchema,
    diagnostic: Schema.NullOr(Schema.String),
  }),
]);

// ---------------------------------------------------------------------------
// The three projected facts
// ---------------------------------------------------------------------------

/**
 * Everything that can go wrong before a process row exists to fold a failure
 * into, plus the refused replacement and the interrupted attempt. It is both the
 * durable attempt reason and the `data.reason` of the `editor_launch_failed` API
 * error, so the record and the wire can never drift.
 */
export const editorAttemptFailureReasonSchema = Schema.Literals([
  'port_allocation_failed',
  'session_socket_unavailable',
  'launch_allocation_failed',
  'launch_interrupted',
  'previous_incarnation_not_stopped',
  'launch_target_missing',
]);

export const editorAttemptSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal('none') }),
  Schema.Struct({ state: Schema.Literal('in_progress'), startedAt: Schema.String }),
  Schema.Struct({
    state: Schema.Literal('failed'),
    reason: editorAttemptFailureReasonSchema,
    detail: Schema.NullOr(Schema.String),
  }),
]);

/**
 * Derived from the incarnation's process row. Deliberately a small editor-owned
 * union rather than `sessionDiagnosticCodeSchema`, which is harness-shaped and
 * would drag harness vocabulary onto an editor that has none.
 */
export const editorProcessDiagnosticSchema = Schema.Literals([
  'launch_failed',
  'attach_failed',
  'process_missing',
  'exited',
  'killed',
]);

export const editorWorkbenchReadinessSchema = Schema.Literals([
  'pending',
  'ready',
  'unreachable',
  'unknown',
]);

export const editorEndpointSchema = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  /**
   * Absolute loopback origin the pane frames. Composed by the runtime so no
   * client ever assembles a URL from parts.
   */
  url: Schema.String.check(Schema.isMinLength(1)),
});

/**
 * Everything the editor domain itself can answer for. It carries no `paneId`,
 * because placement is a surfaces fact and the editor domain does not read
 * panes — which is why this is split from the pane metadata below rather than
 * being one schema with a field the editor could never fill.
 */
export const editorContextFactsSchema = Schema.Struct({
  id: positiveInteger,
  worktreeId: positiveInteger,
  /**
   * The current incarnation, or `null` when there is none. Exposed because the
   * pane needs an identity to key incarnation-scoped reads against: diagnostics
   * belong to one incarnation, and a replacement supersedes it. It is a fact the
   * runtime already owns, not a handle the client may operate on.
   */
  activePtyProcessId: Schema.NullOr(positiveInteger),
  attempt: editorAttemptSchema,
  /** Absent whenever there is no incarnation pointer; never defaulted to `starting`. */
  processStatus: Schema.NullOr(sessionStatusSchema),
  processDiagnostic: Schema.NullOr(editorProcessDiagnosticSchema),
  processDiagnosticDetail: Schema.NullOr(Schema.String),
  workbenchReadiness: Schema.NullOr(editorWorkbenchReadinessSchema),
  readinessDetail: Schema.NullOr(Schema.String),
  /**
   * Present only while an incarnation pointer exists; the pane frames it only
   * when `workbenchReadiness` is `ready`.
   */
  endpoint: Schema.NullOr(editorEndpointSchema),
  /**
   * True when the incarnation retains readable startup output, so the pane can
   * offer the diagnostics disclosure without a speculative fetch.
   */
  hasDiagnostics: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

/**
 * The pane-bound projection: the editor's own facts plus the placement the
 * surfaces layer adds while composing surface detail.
 */
export const editorContextMetadataSchema = Schema.Struct({
  paneId: positiveInteger,
  ...editorContextFactsSchema.fields,
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const openEditorRouteParamsSchema = Schema.Struct({
  worktreeId: positiveInteger,
});

/**
 * Where to place the editor *if it is not placed yet*. `intoSurfaceId` names an
 * empty surface of the same worktree; null creates a new surface. An editor
 * that is already placed is never moved: opening it answers with its existing
 * placement whatever this says.
 */
export const openEditorInputSchema = Schema.Struct({
  intoSurfaceId: Schema.NullOr(positiveInteger),
});

export const editorContextRouteParamsSchema = Schema.Struct({
  editorContextId: positiveInteger,
});

/**
 * Placement is the operation's answer, which is why opening an editor adds no
 * public "which surface holds the editor?" read.
 */
export const openEditorOutputSchema = Schema.Struct({
  worktreeId: positiveInteger,
  surfaceId: positiveInteger,
  paneId: positiveInteger,
  editorContextId: positiveInteger,
});

export const ensureEditorRuntimeInputSchema = Schema.Struct({
  intent: Schema.Literals(['reuse', 'replace']),
});

/**
 * The operation's own answer, not a pane projection: surface detail remains the
 * single authoritative full projection, and the client invalidates it rather
 * than patching from this.
 */
export const ensureEditorRuntimeOutputSchema = Schema.Struct({
  editorContext: editorContextFactsSchema,
});

export const retryEditorProvisioningOutputSchema = Schema.Struct({
  provisioning: editorProvisioningStateSchema,
});

/**
 * A bounded read of the incarnation's retained startup output. Fetched on demand
 * from a settled pane, never streamed and never composed into surface detail.
 */
export const editorDiagnosticsQuerySchema = Schema.Struct({
  /**
   * The incarnation the caller believes it is looking at. Required, and checked
   * against the context's current pointer, so output can never be attributed to
   * the wrong incarnation after a replacement.
   */
  ptyProcessId: positiveInteger,
});

export const editorDiagnosticsOutputSchema = Schema.Struct({
  editorContextId: positiveInteger,
  /**
   * Echoed verbatim from the request, so a response can be matched to the
   * incarnation it describes even if it arrives late.
   */
  ptyProcessId: positiveInteger,
  /**
   * The tail of the log. Empty string when the incarnation produced no output;
   * `null` when no log is retained at all.
   */
  excerpt: Schema.NullOr(Schema.String),
  /** True when output was dropped from the front of the excerpt. */
  truncated: Schema.Boolean,
  totalBytes: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
});

export type EditorProvisioningFailureReason = typeof editorProvisioningFailureReasonSchema.Type;
export type EditorProvisioningState = typeof editorProvisioningStateSchema.Type;
export type EditorAttemptFailureReason = typeof editorAttemptFailureReasonSchema.Type;
export type EditorAttempt = typeof editorAttemptSchema.Type;
export type EditorProcessDiagnostic = typeof editorProcessDiagnosticSchema.Type;
export type EditorWorkbenchReadiness = typeof editorWorkbenchReadinessSchema.Type;
export type EditorEndpoint = typeof editorEndpointSchema.Type;
export type EditorContextFacts = typeof editorContextFactsSchema.Type;
export type EditorContextMetadata = typeof editorContextMetadataSchema.Type;
export type OpenEditorRouteParams = typeof openEditorRouteParamsSchema.Type;
export type EditorContextRouteParams = typeof editorContextRouteParamsSchema.Type;
export type OpenEditorInput = typeof openEditorInputSchema.Type;
export type OpenEditorOutput = typeof openEditorOutputSchema.Type;
export type EnsureEditorRuntimeInput = typeof ensureEditorRuntimeInputSchema.Type;
export type EnsureEditorRuntimeOutput = typeof ensureEditorRuntimeOutputSchema.Type;
export type RetryEditorProvisioningOutput = typeof retryEditorProvisioningOutputSchema.Type;
export type EditorDiagnosticsQuery = typeof editorDiagnosticsQuerySchema.Type;
export type EditorDiagnosticsOutput = typeof editorDiagnosticsOutputSchema.Type;
