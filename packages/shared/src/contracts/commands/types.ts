import { Schema } from 'effect';

import {
  ptyStreamExitMessageSchema,
  ptyStreamOutputMessageSchema,
  ptyStreamReplayEndMessageSchema,
  ptyStreamReplayStartMessageSchema,
  ptyStreamTransportErrorCodeSchema,
} from '../pty-stream/types.js';
import { positiveInteger } from '../scalars.js';

export const worktreeCommandsRouteParamsSchema = Schema.Struct({
  worktreeId: positiveInteger,
});

export const worktreeCommandQuerySchema = Schema.Struct({
  commandName: Schema.String.check(Schema.isMinLength(1)),
});

export const worktreeCommandActionInputSchema = Schema.Struct({
  commandName: Schema.String.check(Schema.isMinLength(1)),
});

export const commandStatusSchema = Schema.Literals([
  'idle',
  'running',
  'exited',
  'stopped',
  'failed',
  'suspended',
]);

// Run history keeps its own vocabulary. It is declared independently of
// `commandStatusSchema` so widening the durable entity status can never widen a
// completed run's status by accident; `suspended` is an entity-level resume
// intent and is never a run outcome.
export const commandRunStatusSchema = Schema.Literals(['running', 'exited', 'stopped', 'failed']);

// One labelled HTTP URL served by a resolved command port. `path` is the
// host-independent path the config declared; `url` is the complete URL the
// runtime composed from it, so no client ever reassembles the formula.
export const commandPortUrlSchema = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1)),
  path: Schema.String.check(Schema.isMinLength(1)),
  url: Schema.String.check(Schema.isMinLength(1)),
});

// One port a running command incarnation actually received. `envVar` names the
// variable an allocated port was injected under, and is null for a fixed port.
// A port with no declared paths carries an empty `urls` list.
export const commandPortSchema = Schema.Struct({
  port: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  envVar: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  urls: Schema.Array(commandPortUrlSchema),
});

export const commandSummarySchema = Schema.Struct({
  name: Schema.String,
  status: commandStatusSchema,
  // Resolved-port metadata, exposed only while the command is running. While
  // running, an array is this incarnation's authoritative resolution — `[]`
  // genuinely means it declared no ports — and `null` is honest "unknown for
  // this incarnation" degradation. While not running it is always `[]`.
  ports: Schema.NullOr(Schema.Array(commandPortSchema)),
});

export const commandActionOutputSchema = Schema.Struct({
  worktreeId: positiveInteger,
  commandName: Schema.String.check(Schema.isMinLength(1)),
  summary: commandSummarySchema,
});

export const commandRunDiagnosticReasonSchema = Schema.Literals([
  'missing_cwd',
  'env_invalid',
  'pty_launch_failed',
  'port_allocation_failed',
  'runtime_stopped',
  'process_control_failed',
]);

export const commandRunDiagnosticSchema = Schema.Struct({
  reason: commandRunDiagnosticReasonSchema,
  detail: Schema.NullOr(Schema.String),
});

export const commandLogMetadataLatestRunSchema = Schema.Struct({
  id: positiveInteger,
  startedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  status: commandRunStatusSchema,
  ptyProcessId: Schema.NullOr(positiveInteger),
  hasPtyProcess: Schema.Boolean,
  diagnostic: Schema.NullOr(commandRunDiagnosticSchema),
});

export const commandLogMetadataOutputSchema = Schema.Struct({
  worktreeId: positiveInteger,
  commandName: Schema.String.check(Schema.isMinLength(1)),
  status: commandStatusSchema,
  latestRun: Schema.NullOr(commandLogMetadataLatestRunSchema),
});

export const commandLogStreamErrorCodeSchema = Schema.Union([
  ptyStreamTransportErrorCodeSchema,
  Schema.Literals([
    'read_only_stream',
    'worktree_not_found',
    'command_config_invalid',
    'command_not_found',
  ]),
]);

export const commandLogStreamStateMessageSchema = Schema.Struct({
  type: Schema.Literal('command_log_state'),
  worktreeId: positiveInteger,
  commandName: Schema.String.check(Schema.isMinLength(1)),
  status: commandStatusSchema,
  latestRun: Schema.NullOr(commandLogMetadataLatestRunSchema),
  live: Schema.Boolean,
});

export const commandLogStreamErrorMessageSchema = Schema.Struct({
  type: Schema.Literal('error'),
  code: commandLogStreamErrorCodeSchema,
  // Diagnostic detail for logs and support. Clients render copy keyed off `code`,
  // never this string. May be absent when there is nothing useful to add.
  message: Schema.optional(Schema.String),
});

export const commandLogStreamOutputMessageSchema = Schema.Union([
  commandLogStreamStateMessageSchema,
  ptyStreamReplayStartMessageSchema,
  ptyStreamOutputMessageSchema,
  ptyStreamReplayEndMessageSchema,
  ptyStreamExitMessageSchema,
  commandLogStreamErrorMessageSchema,
]);

export const commandConfigDiagnosticSchema = Schema.Struct({
  code: Schema.Literal('command_config_invalid'),
  path: Schema.String,
  message: Schema.String,
});

export const worktreeCommandsOutputSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('configured'),
    worktreeId: positiveInteger,
    commands: Schema.Array(commandSummarySchema),
    removedCommands: Schema.Array(commandSummarySchema),
  }),
  Schema.Struct({
    status: Schema.Literal('config_error'),
    worktreeId: positiveInteger,
    diagnostic: commandConfigDiagnosticSchema,
    managedCommands: Schema.Array(commandSummarySchema),
  }),
]);

export type WorktreeCommandsRouteParams = typeof worktreeCommandsRouteParamsSchema.Type;
export type WorktreeCommandQuery = typeof worktreeCommandQuerySchema.Type;
export type WorktreeCommandActionInput = typeof worktreeCommandActionInputSchema.Type;
export type CommandStatus = typeof commandStatusSchema.Type;
export type CommandRunStatus = typeof commandRunStatusSchema.Type;
export type CommandPortUrl = typeof commandPortUrlSchema.Type;
export type CommandPort = typeof commandPortSchema.Type;
export type CommandSummary = typeof commandSummarySchema.Type;
export type CommandActionOutput = typeof commandActionOutputSchema.Type;
export type CommandRunDiagnosticReason = typeof commandRunDiagnosticReasonSchema.Type;
export type CommandRunDiagnostic = typeof commandRunDiagnosticSchema.Type;
export type CommandLogMetadataLatestRun = typeof commandLogMetadataLatestRunSchema.Type;
export type CommandLogMetadataOutput = typeof commandLogMetadataOutputSchema.Type;
export type CommandLogStreamErrorCode = typeof commandLogStreamErrorCodeSchema.Type;
export type CommandLogStreamStateMessage = typeof commandLogStreamStateMessageSchema.Type;
export type CommandLogStreamOutputMessage = typeof commandLogStreamOutputMessageSchema.Type;
export type CommandConfigDiagnostic = typeof commandConfigDiagnosticSchema.Type;
export type WorktreeCommandsOutput = typeof worktreeCommandsOutputSchema.Type;
