import { Schema } from 'effect';

const nonNegativeIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

export const ptyStreamReplayStartMessageSchema = Schema.Struct({
  type: Schema.Literal('replay_start'),
  bytes: nonNegativeIntegerSchema,
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
  exitCode: Schema.NullOr(nonNegativeIntegerSchema),
  signal: Schema.NullOr(Schema.String),
});

export const ptyStreamTransportErrorCodeSchema = Schema.Literal(
  'invalid_message',
  'stream_superseded',
  'backend_unavailable',
  'backend_session_missing',
  'backend_attach_failed',
  'log_read_failed',
  'pty_state_load_failed',
  'unknown',
);

export const ptyStreamErrorCodeSchema = ptyStreamTransportErrorCodeSchema;

export const ptyStreamKnownErrorCodeSchema = Schema.Literal(
  'invalid_session_id',
  'invalid_message',
  'session_not_found',
  'session_not_running',
  'active_process_missing',
  'active_process_not_running',
  'harness_metadata_missing',
  'harness_metadata_invalid',
  'unsupported_harness',
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
);

export const ptyStreamErrorMessageSchema = Schema.Struct({
  type: Schema.Literal('error'),
  code: ptyStreamKnownErrorCodeSchema,
  // Diagnostic detail for logs and support. Clients render copy keyed off `code`,
  // never this string. May be absent when there is nothing useful to add.
  message: Schema.optional(Schema.String),
});

export const ptyStreamOutputMessageSetSchema = Schema.Union(
  ptyStreamReplayStartMessageSchema,
  ptyStreamOutputMessageSchema,
  ptyStreamReplayEndMessageSchema,
  ptyStreamExitMessageSchema,
);

export type PtyStreamReplayStartMessage = Schema.Schema.Type<
  typeof ptyStreamReplayStartMessageSchema
>;
export type PtyStreamOutputMessage = Schema.Schema.Type<typeof ptyStreamOutputMessageSchema>;
export type PtyStreamReplayEndMessage = Schema.Schema.Type<typeof ptyStreamReplayEndMessageSchema>;
export type PtyStreamExitMessage = Schema.Schema.Type<typeof ptyStreamExitMessageSchema>;
export type PtyStreamErrorCode = Schema.Schema.Type<typeof ptyStreamKnownErrorCodeSchema>;
export type PtyStreamErrorMessage = {
  readonly type: 'error';
  readonly code: PtyStreamErrorCode;
  readonly message?: string | undefined;
};
export type PtyStreamOutputMessageSet = Schema.Schema.Type<typeof ptyStreamOutputMessageSetSchema>;
