import { Data } from 'effect';

import {
  RuntimeApiError,
  RuntimeDecodeError,
  RuntimeTransportError,
  type RuntimeClientError,
} from '@isagi/runtime-client';

import type { CliErrorCode } from './error-codes.js';

export { cliErrorCodeSchema, type CliErrorCode } from './error-codes.js';

/**
 * The one error document every failure prints: `{ code, reason?, message, requestId?, stage?, data? }`.
 * `code` is a `CliErrorCode` or, for an API failure, the runtime envelope's code.
 */
export interface ErrorDocument {
  readonly code: string;
  readonly reason?: string;
  readonly message: string;
  readonly requestId?: string;
  readonly stage?: string;
  readonly data?: unknown;
}

export class CliFailure extends Data.TaggedError('CliFailure')<{
  readonly document: ErrorDocument;
}> {
  static of(code: CliErrorCode, message: string, data?: unknown): CliFailure {
    return new CliFailure({
      document: data === undefined ? { code, message } : { code, message, data },
    });
  }
}

/**
 * A runtime-client failure as the CLI reports it.
 *
 * An API failure keeps the envelope's code, lifts `data.reason` into `reason`, and passes
 * `requestId` and `data` through. `runtimeUrl` is safe to report because targeting refuses any URL
 * that carries credentials.
 */
export function fromRuntimeError(
  error: RuntimeClientError,
  context: { readonly endpointId: string; readonly runtimeUrl: string },
): CliFailure {
  if (error instanceof RuntimeApiError) {
    const apiError = error.apiError as {
      readonly code: string;
      readonly message: string;
      readonly requestId: string;
      readonly data?: unknown;
    };
    const reason = reasonOf(apiError.data);
    return new CliFailure({
      document: {
        code: apiError.code,
        ...(reason === undefined ? {} : { reason }),
        message: apiError.message,
        requestId: apiError.requestId,
        ...(apiError.data === undefined ? {} : { data: apiError.data }),
      },
    });
  }
  if (error instanceof RuntimeDecodeError) {
    return CliFailure.of('runtime_response_invalid', error.message, {
      endpointId: error.endpointId,
    });
  }
  if (error instanceof RuntimeTransportError) {
    return CliFailure.of(
      'runtime_unreachable',
      `Could not reach the Isagi runtime at ${context.runtimeUrl}.`,
      {
        endpointId: context.endpointId,
        runtimeUrl: context.runtimeUrl,
        cause: causeText(error.cause),
      },
    );
  }
  return CliFailure.of('runtime_response_invalid', String(error));
}

function reasonOf(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'reason' in data && typeof data.reason === 'string') {
    return data.reason;
  }
  return undefined;
}

export function causeText(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause;
    return inner instanceof Error ? `${cause.message}: ${inner.message}` : cause.message;
  }
  return String(cause);
}

/** A local write that failed, with the path and the errno a person needs to act on it. */
export function writeFailure(path: string, cause: unknown): CliFailure {
  return CliFailure.of('filesystem_write_failed', `Could not write ${path}: ${causeText(cause)}`, {
    path,
    errno: errnoOf(cause) ?? null,
  });
}

/** The Node errno code (`ENOENT`, `EEXIST`, …) of a filesystem or socket failure, if it has one. */
export function errnoOf(cause: unknown): string | undefined {
  return cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined;
}
