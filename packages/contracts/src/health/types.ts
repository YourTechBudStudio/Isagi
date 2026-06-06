import { Schema } from 'effect';

export const healthOutputSchema = Schema.Struct({
  context: Schema.Struct({
    arch: Schema.String,
    node: Schema.String,
    pid: Schema.Number.pipe(Schema.int(), Schema.positive()),
    platform: Schema.String,
  }),
  name: Schema.Literal('isagi-runtime'),
  ok: Schema.Literal(true),
  timestamp: Schema.String,
  version: Schema.String,
});

export type HealthOutput = Schema.Schema.Type<typeof healthOutputSchema>;
