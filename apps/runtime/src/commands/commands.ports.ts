import { Schema } from 'effect';

import type { CommandPortPathConfig } from '../project-config/project-config.schema.js';

// The resolved-port vocabulary shared by persistence, launch, and projection.
//
// A resolved entry is a *source fact* about one command incarnation: which port
// it actually got, and — for an allocated entry — the environment variable the
// value was injected under. `envVar` doubles as the allocation identity a later
// launch matches its preference against, so a fixed entry carries null: there is
// nothing to remember for a port the user already fixed.
//
// Paths are stored exactly as declared. URLs are composed at read time
// (`commands.summary.ts`), so the durable row never holds a derived value.
export interface ResolvedPortEntry {
  readonly envVar: string | null;
  readonly port: number;
  readonly paths: readonly CommandPortPathConfig[];
}

// The decode boundary for the persisted snapshot. Historical or hand-edited rows
// are outside the model's control, so the repository folds a decode failure into
// the contract's honest `null` rather than failing the read.
export const resolvedPortsSnapshotSchema = Schema.Array(
  Schema.Struct({
    envVar: Schema.NullOr(Schema.String.pipe(Schema.minLength(1))),
    port: Schema.Number.pipe(Schema.int(), Schema.between(1, 65_535)),
    paths: Schema.Array(
      Schema.Struct({
        label: Schema.String.pipe(Schema.minLength(1)),
        path: Schema.String.pipe(Schema.minLength(1)),
      }),
    ),
  }),
);
