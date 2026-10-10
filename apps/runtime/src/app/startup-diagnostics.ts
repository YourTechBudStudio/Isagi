import { Cause } from 'effect';

export function formatStartupFailure(cause: Cause.Cause<unknown>) {
  return `ISAGI_RUNTIME_STARTUP_FAILED\n${Cause.pretty(cause, { renderErrorCause: true })}`;
}
