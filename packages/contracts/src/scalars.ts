import { Schema } from 'effect';

/** Shared wire scalars. Every contract module uses these instead of declaring its own copy. */

export const positiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
export const nonNegativeInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
export const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
