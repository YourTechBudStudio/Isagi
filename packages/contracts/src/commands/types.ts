import { Schema } from 'effect';

import {
  ptyStreamErrorCodeSchema,
  ptyStreamErrorMessageSchema,
  ptyStreamExitMessageSchema,
  ptyStreamOutputMessageSchema,
  ptyStreamReplayEndMessageSchema,
  ptyStreamReplayStartMessageSchema,
} from '../pty-stream/types.js';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const worktreeCommandsRouteParamsSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
});

export const worktreeCommandQuerySchema = Schema.Struct({
  commandName: Schema.String.pipe(Schema.minLength(1)),
});

export const worktreeCommandActionInputSchema = Schema.Struct({
  commandName: Schema.String.pipe(Schema.minLength(1)),
});

export const commandStatusSchema = Schema.Literal('idle', 'running', 'exited', 'stopped', 'failed');

export const commandSummarySchema = Schema.Struct({
  name: Schema.String,
  status: commandStatusSchema,
  ports: Schema.Array(Schema.Number.pipe(Schema.int(), Schema.between(1, 65_535))),
});

export const commandActionOutputSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
  commandName: Schema.String.pipe(Schema.minLength(1)),
  summary: commandSummarySchema,
});

export const commandRunDiagnosticReasonSchema = Schema.Literal(
  'missing_cwd',
  'env_invalid',
  'pty_launch_failed',
  'runtime_stopped',
);

export const commandRunDiagnosticSchema = Schema.Struct({
  reason: commandRunDiagnosticReasonSchema,
  detail: Schema.NullOr(Schema.String),
});

export const commandLogMetadataLatestRunSchema = Schema.Struct({
  id: positiveIntegerSchema,
  startedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  status: Schema.Literal('running', 'exited', 'stopped', 'failed'),
  ptyProcessId: Schema.NullOr(positiveIntegerSchema),
  hasPtyProcess: Schema.Boolean,
  diagnostic: Schema.NullOr(commandRunDiagnosticSchema),
});

export const commandLogMetadataOutputSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
  commandName: Schema.String.pipe(Schema.minLength(1)),
  status: commandStatusSchema,
  latestRun: Schema.NullOr(commandLogMetadataLatestRunSchema),
});

export const commandLogStreamErrorCodeSchema = ptyStreamErrorCodeSchema;

export const commandLogStreamStateMessageSchema = Schema.Struct({
  type: Schema.Literal('command_log_state'),
  worktreeId: positiveIntegerSchema,
  commandName: Schema.String.pipe(Schema.minLength(1)),
  status: commandStatusSchema,
  latestRun: Schema.NullOr(commandLogMetadataLatestRunSchema),
  live: Schema.Boolean,
});

export const commandLogStreamErrorMessageSchema = ptyStreamErrorMessageSchema;

export const commandLogStreamOutputMessageSchema = Schema.Union(
  commandLogStreamStateMessageSchema,
  ptyStreamReplayStartMessageSchema,
  ptyStreamOutputMessageSchema,
  ptyStreamReplayEndMessageSchema,
  ptyStreamExitMessageSchema,
  commandLogStreamErrorMessageSchema,
);

export const commandConfigDiagnosticSchema = Schema.Struct({
  code: Schema.Literal('command_config_invalid'),
  path: Schema.String,
  message: Schema.String,
});

export const worktreeCommandsOutputSchema = Schema.Union(
  Schema.Struct({
    status: Schema.Literal('configured'),
    worktreeId: positiveIntegerSchema,
    commands: Schema.Array(commandSummarySchema),
    removedCommands: Schema.Array(commandSummarySchema),
  }),
  Schema.Struct({
    status: Schema.Literal('config_error'),
    worktreeId: positiveIntegerSchema,
    diagnostic: commandConfigDiagnosticSchema,
    managedCommands: Schema.Array(commandSummarySchema),
  }),
);

export type WorktreeCommandsRouteParams = Schema.Schema.Type<
  typeof worktreeCommandsRouteParamsSchema
>;
export type WorktreeCommandQuery = Schema.Schema.Type<typeof worktreeCommandQuerySchema>;
export type WorktreeCommandActionInput = Schema.Schema.Type<
  typeof worktreeCommandActionInputSchema
>;
export type CommandStatus = Schema.Schema.Type<typeof commandStatusSchema>;
export type CommandSummary = Schema.Schema.Type<typeof commandSummarySchema>;
export type CommandActionOutput = Schema.Schema.Type<typeof commandActionOutputSchema>;
export type CommandRunDiagnosticReason = Schema.Schema.Type<
  typeof commandRunDiagnosticReasonSchema
>;
export type CommandRunDiagnostic = Schema.Schema.Type<typeof commandRunDiagnosticSchema>;
export type CommandLogMetadataLatestRun = Schema.Schema.Type<
  typeof commandLogMetadataLatestRunSchema
>;
export type CommandLogMetadataOutput = Schema.Schema.Type<typeof commandLogMetadataOutputSchema>;
export type CommandLogStreamErrorCode = Schema.Schema.Type<typeof commandLogStreamErrorCodeSchema>;
export type CommandLogStreamStateMessage = Schema.Schema.Type<
  typeof commandLogStreamStateMessageSchema
>;
export type CommandLogStreamOutputMessage = Schema.Schema.Type<
  typeof commandLogStreamOutputMessageSchema
>;
export type CommandConfigDiagnostic = Schema.Schema.Type<typeof commandConfigDiagnosticSchema>;
export type WorktreeCommandsOutput = Schema.Schema.Type<typeof worktreeCommandsOutputSchema>;
