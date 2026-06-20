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
export type PtyStreamOutputMessageSet = Schema.Schema.Type<typeof ptyStreamOutputMessageSetSchema>;
