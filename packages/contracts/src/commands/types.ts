import { Schema } from 'effect';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const worktreeCommandsRouteParamsSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
});

export const commandStatusSchema = Schema.Literal('idle', 'running', 'exited', 'stopped', 'failed');

export const commandSummarySchema = Schema.Struct({
  name: Schema.String,
  status: commandStatusSchema,
  ports: Schema.Array(Schema.Number.pipe(Schema.int(), Schema.between(1, 65_535))),
});

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
  }),
  Schema.Struct({
    status: Schema.Literal('config_error'),
    worktreeId: positiveIntegerSchema,
    diagnostic: commandConfigDiagnosticSchema,
  }),
);

export type WorktreeCommandsRouteParams = Schema.Schema.Type<
  typeof worktreeCommandsRouteParamsSchema
>;
export type CommandStatus = Schema.Schema.Type<typeof commandStatusSchema>;
export type CommandSummary = Schema.Schema.Type<typeof commandSummarySchema>;
export type CommandConfigDiagnostic = Schema.Schema.Type<typeof commandConfigDiagnosticSchema>;
export type WorktreeCommandsOutput = Schema.Schema.Type<typeof worktreeCommandsOutputSchema>;
