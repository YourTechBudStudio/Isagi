import { Schema } from 'effect';

/**
 * The lifecycle of a runtime-owned OS process, shared by every domain that
 * supervises one. It lives here rather than in `surfaces/types.ts` because both
 * `surfaces` and `editor` need it and `surfaces` imports `editor`: keeping it in
 * either of those modules would close an import cycle, and a cycle between two
 * eagerly-evaluated `Schema` graphs fails at module load rather than at
 * type-check.
 *
 * The name still says `session` because a rename to `processStatus` would touch
 * roughly forty runtime and web files for no behavioural gain. It is a clean
 * mechanical follow-up, deliberately not bundled with the editor work.
 */
export const sessionStatusSchema = Schema.Literal(
  'starting',
  'running',
  'exited',
  'failed',
  'killed',
);

export type SessionStatus = Schema.Schema.Type<typeof sessionStatusSchema>;
