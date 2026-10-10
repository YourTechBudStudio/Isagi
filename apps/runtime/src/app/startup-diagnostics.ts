import { Cause } from 'effect';

// Effect v4's `Cause.pretty` always renders each error's `cause` chain, which is what keeps the raw
// native failure (for example a better-sqlite3 load error) in the startup line.
export function formatStartupFailure(cause: Cause.Cause<unknown>) {
  return `ISAGI_RUNTIME_STARTUP_FAILED\n${Cause.pretty(cause)}`;
}
