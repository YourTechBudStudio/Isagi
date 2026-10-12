import { Data } from 'effect';

import type { ApiError } from '@isagi/contracts';

/** The runtime answered with its `{ error }` envelope. `apiError` is the decoded contract shape. */
export class RuntimeApiError<E extends ApiError = ApiError> extends Data.TaggedError(
  'RuntimeApiError',
)<{
  readonly endpointId: string;
  readonly apiError: E;
}> {
  override get message() {
    return this.apiError.message;
  }
}

/**
 * The request never produced a response (network, abort, DNS, CORS) or its body broke mid-read.
 * `cause` is the platform error (fetch's `TypeError` and its errno cause), not an `effect/http`
 * wrapper, so clients that print it keep saying `fetch failed: connect ECONNREFUSED …`.
 */
export class RuntimeTransportError extends Data.TaggedError('RuntimeTransportError')<{
  readonly endpointId: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Could not reach runtime endpoint ${this.endpointId}.`;
  }
}

/** A response arrived but did not match the endpoint's contract. */
export class RuntimeDecodeError extends Data.TaggedError('RuntimeDecodeError')<{
  readonly endpointId: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Runtime response for ${this.endpointId} did not match the API contract.`;
  }
}

export type RuntimeClientError = RuntimeApiError | RuntimeTransportError | RuntimeDecodeError;
