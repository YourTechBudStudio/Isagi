import { Schema } from 'effect';

export const healthOutputSchema = Schema.Struct({
  context: Schema.Struct({
    arch: Schema.String,
    node: Schema.String,
    pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    platform: Schema.String,
  }),
  name: Schema.Literal('isagi-runtime'),
  ok: Schema.Literal(true),
  timestamp: Schema.String,
  version: Schema.String,
});

export type HealthOutput = typeof healthOutputSchema.Type;
