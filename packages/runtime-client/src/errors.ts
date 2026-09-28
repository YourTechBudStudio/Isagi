import type { ApiError } from '@isagi/contracts';

export class RuntimeApiError<ErrorShape extends ApiError = ApiError> extends Error {
  readonly apiError: ErrorShape;

  constructor(apiError: ErrorShape) {
    super(apiError.message);
    this.name = 'RuntimeApiError';
    this.apiError = apiError;
  }
}

export class RuntimeTransportError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'RuntimeTransportError';
    this.cause = cause;
  }
}

export class RuntimeDecodeError extends Error {
  readonly cause: unknown;
  readonly endpointId: string;

  constructor(endpointId: string, cause: unknown) {
    super(`Runtime response for ${endpointId} did not match the API contract.`);
    this.name = 'RuntimeDecodeError';
    this.endpointId = endpointId;
    this.cause = cause;
  }
}

export type RuntimeClientError = RuntimeApiError | RuntimeTransportError | RuntimeDecodeError;
