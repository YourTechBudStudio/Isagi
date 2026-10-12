/**
 * Pure readers of `AsyncResult` for components. Components use `AsyncResult` directly; these cover
 * the three states that need a rule.
 */
import { Cause } from 'effect';
import type { AsyncResult } from 'effect/reactivity';

/** A query's error: any failure, also while a refetch runs. Squashed like `runPromise` rejections. */
export const queryError = <A, E>(result: AsyncResult.AsyncResult<A, E>): unknown =>
  result._tag === 'Failure' ? Cause.squash(result.cause) : null;

/**
 * A mutation's error: a settled failure only. A rerun after a failure is `Failure` + `waiting`, and
 * the error is hidden while it runs, as React Query cleared `error` when a new mutate started.
 */
export const mutationError = <A, E>(result: AsyncResult.AsyncResult<A, E>): unknown =>
  result._tag === 'Failure' && !result.waiting ? Cause.squash(result.cause) : null;

/** A mutation's data: a settled success only (also cleared while a new run is in flight). */
export const mutationData = <A, E>(result: AsyncResult.AsyncResult<A, E>): A | undefined =>
  result._tag === 'Success' && !result.waiting ? result.value : undefined;
