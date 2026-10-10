import { Schema } from 'effect';

import { nonNegativeInteger } from '../scalars.js';

export const ptyStreamReplayStartMessageSchema = Schema.Struct({
  type: Schema.Literal('replay_start'),
  bytes: nonNegativeInteger,
});

export const ptyStreamOutputMessageSchema = Schema.Struct({
  type: Schema.Literal('output'),
  data: Schema.String,
  replay: Schema.optional(Schema.Boolean),
});

export const ptyStreamReplayEndMessageSchema = Schema.Struct({
  type: Schema.Literal('replay_end'),
});

export const ptyStreamExitMessageSchema = Schema.Struct({
  type: Schema.Literal('exit'),
  exitCode: Schema.NullOr(nonNegativeInteger),
  signal: Schema.NullOr(Schema.String),
});

export const ptyStreamTransportErrorCodeSchema = Schema.Literals([
  'invalid_message',
  'stream_superseded',
  'backend_unavailable',
  'backend_session_missing',
  'backend_attach_failed',
  'log_read_failed',
  'pty_state_load_failed',
  'unknown',
]);

export const ptyStreamErrorCodeSchema = ptyStreamTransportErrorCodeSchema;

export const ptyStreamKnownErrorCodeSchema = Schema.Literals([
  'invalid_session_id',
  'invalid_message',
  'session_not_found',
  'session_not_running',
  'active_process_missing',
  'active_process_not_running',
  'harness_metadata_missing',
  'harness_metadata_invalid',
  'unsupported_harness',
  'onboarding_incomplete',
  'config_invalid',
  'inventory_pending',
  'harness_disabled',
  'harness_missing',
  'harness_incompatible',
  'harness_probe_failed',
  'session_already_attached',
  'session_attachment_moved',
  'stream_superseded',
  'attach_token_missing',
  'attach_token_invalid',
  'attach_token_expired',
  'read_only_stream',
  'worktree_not_found',
  'command_config_invalid',
  'command_not_found',
  'backend_unavailable',
  'backend_session_missing',
  'backend_attach_failed',
  'log_read_failed',
  'pty_write_failed',
  'pty_state_load_failed',
  'unknown',
]);

export const ptyStreamErrorMessageSchema = Schema.Struct({
  type: Schema.Literal('error'),
  code: ptyStreamKnownErrorCodeSchema,
  // Diagnostic detail for logs and support. Clients render copy keyed off `code`,
  // never this string. May be absent when there is nothing useful to add.
  message: Schema.optional(Schema.String),
});

export const ptyStreamOutputMessageSetSchema = Schema.Union([
  ptyStreamReplayStartMessageSchema,
  ptyStreamOutputMessageSchema,
  ptyStreamReplayEndMessageSchema,
  ptyStreamExitMessageSchema,
]);

export type PtyStreamReplayStartMessage = typeof ptyStreamReplayStartMessageSchema.Type;
export type PtyStreamOutputMessage = typeof ptyStreamOutputMessageSchema.Type;
export type PtyStreamReplayEndMessage = typeof ptyStreamReplayEndMessageSchema.Type;
export type PtyStreamExitMessage = typeof ptyStreamExitMessageSchema.Type;
export type PtyStreamErrorCode = typeof ptyStreamKnownErrorCodeSchema.Type;
export type PtyStreamErrorMessage = {
  readonly type: 'error';
  readonly code: PtyStreamErrorCode;
  readonly message?: string | undefined;
};
export type PtyStreamOutputMessageSet = typeof ptyStreamOutputMessageSetSchema.Type;
