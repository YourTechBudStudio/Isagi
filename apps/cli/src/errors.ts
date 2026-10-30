import { Data } from 'effect';

import type { RuntimeClientError } from '@isagi/runtime-client';

import type { CliErrorCode } from './error-codes.js';
import { cliRecovery, runtimeRecovery } from './recovery.js';

export { cliErrorCodeSchema, type CliErrorCode } from './error-codes.js';

/**
 * The one error document every failure prints. `code` is a `CliErrorCode` or, for an API failure,
 * the runtime envelope's code.
 */
export interface ErrorDocument {
  readonly code: string;
  readonly message: string;
  /** One or two sentences naming the next concrete step. */
  readonly recovery: string;
  /** What the CLI used and where it came from; `{}` only when there is nothing to report. */
  readonly context: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  readonly requestId?: string;
  /** Runtime-authored data only. */
  readonly data?: unknown;
}

export class CliFailure extends Data.TaggedError('CliFailure')<{
  readonly document: ErrorDocument;
  /** Raised by a raw-output command: rendered to stderr even under --json. */
  readonly raw: boolean;
}> {
  /** A CLI-owned failure; `recovery` defaults to the code's entry in the recovery table. */
  static of(
    code: CliErrorCode,
    message: string,
    options: {
      readonly context?: Readonly<Record<string, unknown>>;
      readonly recovery?: string;
    } = {},
  ): CliFailure {
    return new CliFailure({
      document: {
        code,
        message,
        recovery: options.recovery ?? cliRecovery[code],
        context: options.context ?? {},
      },
      raw: false,
    });
  }

  withContext(extra: Readonly<Record<string, unknown>>): CliFailure {
    return new CliFailure({
      document: { ...this.document, context: { ...this.document.context, ...extra } },
      raw: this.raw,
    });
  }

  inRawCommand(): CliFailure {
    return this.raw ? this : new CliFailure({ document: this.document, raw: true });
  }
}

/**
 * A runtime-client failure as the CLI reports it.
 *
 * An API failure keeps the envelope's code, message, request id and data, lifts `data.reason` into
 * `reason`, and gains a recovery step. `runtimeUrl` is safe to print because targeting refuses any
 * URL that carries credentials; the runner adds it to `context` with its source.
 */
export function fromRuntimeError(
  error: RuntimeClientError,
  context: { readonly endpointId: string; readonly runtimeUrl: string },
): CliFailure {
  switch (error._tag) {
    case 'RuntimeApiError': {
      const { code, message, requestId, data } = error.apiError;
      const reason = reasonOf(data);
      return new CliFailure({
        document: {
          code,
          message,
          recovery: runtimeRecovery(code),
          context: { endpointId: context.endpointId },
          ...(reason === undefined ? {} : { reason }),
          requestId,
          ...(data === undefined ? {} : { data }),
        },
        raw: false,
      });
    }
    case 'RuntimeDecodeError':
      return CliFailure.of('runtime_response_invalid', error.message, {
        context: { endpointId: error.endpointId },
      });
    case 'RuntimeTransportError':
      return CliFailure.of(
        'runtime_unreachable',
        `Could not reach the Isagi runtime at ${context.runtimeUrl}.`,
        { context: { endpointId: context.endpointId, cause: causeText(error.cause) } },
      );
  }
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
    context: { path, errno: errnoOf(cause) ?? null },
  });
}

/** The Node errno code (`ENOENT`, `EEXIST`, …) of a filesystem or socket failure, if it has one. */
export function errnoOf(cause: unknown): string | undefined {
  return cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined;
}
