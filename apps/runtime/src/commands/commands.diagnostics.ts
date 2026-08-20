import { DatabaseError } from '../persistence/index.js';

// Durable command diagnostics are read long after the fact, often from a remote
// machine with no logs, so they have to carry the whole failure chain. The
// operational errors this feature sees — `DatabaseError`, `PtyKillError`,
// `PtyServiceError` — are tagged errors that keep their real context in
// `cause` and frequently have an empty `message`, so reading `message` alone
// would persist a bare tag name like `PtyKillError` and lose the backend
// failure underneath it. One formatter unwraps that chain for every command
// diagnostic, so launch and stop describe a failure the same way.
const maxCauseDepth = 4;

export function describeOperationalCause(cause: unknown, depth = 0): string {
  const label = describeCauseLabel(cause);
  if (depth >= maxCauseDepth) return label;
  const nested = nestedCause(cause);
  if (nested === undefined) return label;
  const inner = describeOperationalCause(nested, depth + 1);
  return label ? `${label}: ${inner}` : inner;
}

function describeCauseLabel(cause: unknown) {
  if (cause instanceof DatabaseError) return `Database operation ${cause.operation} failed`;
  if (cause instanceof Error) return cause.message || tagOf(cause) || cause.name;
  return String(cause);
}

function nestedCause(cause: unknown) {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const nested = (cause as { readonly cause?: unknown }).cause;
  return nested === undefined || nested === null ? undefined : nested;
}

function tagOf(cause: object) {
  const tag = (cause as { readonly _tag?: unknown })._tag;
  return typeof tag === 'string' ? tag : '';
}
