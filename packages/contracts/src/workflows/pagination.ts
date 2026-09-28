import { Schema } from 'effect';

import { nonEmptyString, positiveInteger } from './primitives.js';

/**
 * Shared query vocabulary.
 *
 * The runtime's route decoder turns every all-digit query value into a number before decoding, so a
 * free-text query field must accept that number back as text. Without this a file named `2024` or
 * a scope named `1` would be refused as a type error.
 */
export const queryTextSchema = Schema.transform(
  Schema.Union(nonEmptyString, Schema.Number),
  nonEmptyString,
  { strict: true, decode: (value) => String(value), encode: (value) => value },
);

/**
 * Every workflow list pages the same way: rows are ordered by id, and the cursor is the last id the
 * client received. The runtime returns rows with a greater id, and `nextCursor` is `null` once there
 * is nothing more.
 */
export const cursorSchema = positiveInteger;

/** Default 100, hard maximum 500. An over-large request is rejected rather than clamped. */
export const workflowListPageLimitMaximum = 500;

/** Query fields shared by every list route. */
export const paginationQueryFields = {
  cursor: Schema.optional(cursorSchema),
  limit: Schema.optional(
    positiveInteger.pipe(Schema.lessThanOrEqualTo(workflowListPageLimitMaximum)),
  ),
};

export const paginationQuerySchema = Schema.Struct(paginationQueryFields);

/** The envelope every list route returns. */
export const pagedSchema = <Item extends Schema.Schema.Any>(item: Item) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.NullOr(cursorSchema) });

export type PaginationQuery = typeof paginationQuerySchema.Type;
