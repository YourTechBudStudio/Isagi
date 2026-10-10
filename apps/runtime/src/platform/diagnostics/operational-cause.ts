// The trust boundary between an operational failure and anything a user can
// read.
//
// Runtime diagnostics are persisted and shown in the product, and runtime logs
// end up in bug reports, so everything here is written on the assumption that
// it will be read by someone other than the person whose machine produced it.
// That makes the rule strict: a rendered failure is *composed* from fields this
// codebase authored, never copied from an error's own text.
//
// This module names no error class. An error class that may be rendered opts
// in by implementing the `SafeDiagnostic` protocol below: it composes its own
// label from authored fields (stable codes, operation names, identifiers) and
// hands back the cause to walk next. That keeps platform code free of domain
// vocabulary, and puts each label next to the class whose fields it reads.
//
// The reason is concrete rather than theoretical. A PTY backend ref is decoded
// with Effect Schema, and a schema mismatch renders the offending value —
// `Expected "tmux", actual "<the whole ref field>"`. A ref can carry a
// shell-integration token, so echoing that message would publish a secret into a
// durable, user-visible field. Two authored messages are unsafe for the same
// reason: one interpolates a tmux session name, and `log-replay`'s carries a
// caller-supplied string. So `.message` is never read — not even ours.
//
// What may appear: stable tags and codes, database operation names, backend
// enums, and identifiers (PTY, worktree). What may never appear: secrets, backend refs or any component of one, environment
// values, command lines or process output, and any other untrusted payload.

const maxCauseDepth = 4;

// Foreign error classes are matched against a fixed list rather than validated
// by shape. A pattern check over a constructor name would happily accept
// `SUPERSECRETTOKEN12345`, which is exactly the class of value this module
// exists to keep out; an allowlist cannot.
const knownForeignErrorNames: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  // Effect Schema's decode failure (`ParseError` in Effect v3), the proven
  // value-echoing case. Naming the type is safe; rendering its message is not.
  'SchemaError',
]);

/**
 * The key of the `SafeDiagnostic` method.
 *
 * Module-local on purpose (`Symbol`, never `Symbol.for`): only code that imports
 * this module can implement the protocol, so an arbitrary value — a decoded
 * payload, a foreign error, an object that sets `_tag` or `name` to anything it
 * likes — can never claim to be one of ours. That is the property recognition by
 * class used to provide, without platform code importing every domain's classes.
 */
export const describeSafely: unique symbol = Symbol('isagi.describeSafely');

export interface SafeDescription {
  /** Composed only from fields this codebase authored. Never an error's `message`. */
  readonly label: string;
  /** Walked next, because the value above was recognized. `null`/`undefined` ends the walk. */
  readonly cause: unknown;
}

/** An error class whose failures may be rendered into user-visible diagnostics and logs. */
export interface SafeDiagnostic {
  readonly [describeSafely]: () => SafeDescription;
}

/** Renders an operational failure for a user or a log, under the rules above. */
export function describeOperationalCause(cause: unknown): string {
  return describeCause(cause, 0);
}

/**
 * The walk: a recognized value contributes its label and, below the depth bound,
 * its cause; the first unrecognized value ends the chain with a foreign label. A
 * foreign error's own cause chain is never walked.
 */
function describeCause(value: unknown, depth: number): string {
  const recognized = recognize(value);
  if (!recognized) return foreignErrorLabel(value);
  if (depth >= maxCauseDepth) return recognized.label;
  if (recognized.cause === undefined || recognized.cause === null) return recognized.label;
  return `${recognized.label}: ${describeCause(recognized.cause, depth + 1)}`;
}

function recognize(value: unknown): SafeDescription | null {
  if (typeof value !== 'object' || value === null || !(describeSafely in value)) return null;
  const describe: unknown = (value as Partial<SafeDiagnostic>)[describeSafely];
  return typeof describe === 'function' ? (describe as () => SafeDescription).call(value) : null;
}

// System-call error codes are operating-system enum constants, not payloads,
// which puts them in the same class as the backend enums and database operation
// names this module already renders. Carrying one is the difference between
// "System error EADDRINUSE" and a bare "Error" that tells a support reader
// nothing about whether a port was taken, a limit was hit, or a permission was
// refused.
//
// Membership is exact, never a pattern. A check like /^E[A-Z]+$/ would happily
// admit whatever an unvouched value put in its `code` field, which is precisely
// the leak `knownForeignErrorNames` above exists to prevent. Grow this list only
// when an observed failure justifies an entry.
const knownSystemErrorCodes: ReadonlySet<string> = new Set([
  'EACCES',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EINVAL',
  'EMFILE',
  'ENFILE',
  'ENOTSUP',
  'EPERM',
]);

function foreignErrorLabel(value: unknown) {
  if (!(value instanceof Error)) return 'UnknownError';
  const systemCode = recognizedSystemErrorCode(value);
  if (systemCode) return `System error ${systemCode}`;
  const name: unknown = Object.getPrototypeOf(value)?.constructor?.name;
  return typeof name === 'string' && knownForeignErrorNames.has(name) ? name : 'Error';
}

// Reads `code` and nothing else — not `message`, `syscall`, `address`, `path`,
// or `stack`, each of which can carry a value this codebase did not author.
//
// The own *data* descriptor is the only thing consulted. A plain property read
// would invoke an accessor, which is foreign code running inside the renderer
// whose whole job is to be trustworthy; and an inherited `code` is not something
// this value itself declared.
function recognizedSystemErrorCode(value: Error): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'code');
  if (!descriptor || !('value' in descriptor)) return null;
  const code: unknown = descriptor.value;
  return typeof code === 'string' && knownSystemErrorCodes.has(code) ? code : null;
}

export function coordinates(values: Record<string, string | number | undefined>) {
  const parts = Object.entries(values).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${value}`],
  );
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}
