import { Schema } from 'effect';

import { nonEmptyString } from './primitives.js';

/**
 * Shared query vocabulary.
 *
 * Its own module because `evidence.ts` and `checkpoints.ts` declare their own route inputs and must
 * page and decode booleans identically, while `requests.ts` depends on the execution records that
 * embed a checkpoint summary. A second copy of either is exactly the drift these represent.
 */
export const booleanStringSchema = Schema.Union(Schema.Boolean, Schema.Literal('true', 'false'));

/** Opaque and bound to its run, filters and snapshot boundary. Clients never construct one. */
export const cursorSchema = nonEmptyString;

/**
 * Every list route pages the same way: default 100, hard maximum 500. The maximum is part of the
 * schema rather than prose, so an over-large request is rejected at the boundary instead of being
 * silently clamped or honoured.
 */
export const workflowListPageLimitMaximum = 500;

export const paginationQuerySchema = Schema.Struct({
  limit: Schema.optional(
    Schema.Number.pipe(
      Schema.int(),
      Schema.positive(),
      Schema.lessThanOrEqualTo(workflowListPageLimitMaximum),
    ),
  ),
  cursor: Schema.optional(cursorSchema),
});

export type PaginationQuery = typeof paginationQuerySchema.Type;
