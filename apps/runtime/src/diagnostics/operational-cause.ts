import { DatabaseError } from '../persistence/index.js';
import {
  PtyInspectError,
  PtyKillError,
  PtyResizeError,
  PtyServiceError,
  PtyStartError,
  PtyTerminationInProgressError,
  PtyWriteError,
} from '../pty-processes/types.js';

// The trust boundary between an operational failure and anything a user can
// read.
//
// Runtime diagnostics are persisted and shown in the product, and runtime logs
// end up in bug reports, so everything here is written on the assumption that
// it will be read by someone other than the person whose machine produced it.
// That makes the rule strict: a rendered failure is *composed* from fields this
// codebase authored, never copied from an error's own text.
//
// This module sits at runtime altitude rather than in `lib/` on purpose: it
// recognizes the runtime's own error classes, so it imports `persistence` and
// `pty-processes`. Putting it below them would hand a low-level adapter a
// transitive dependency on two runtime domains. Domains that need to name their
// own error types wrap this instead — see `commands.diagnostics.ts`.
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
  // Effect Schema's decode failure, the proven value-echoing case. Naming the
  // type is safe; rendering its message is not.
  'ParseError',
]);

export interface RecognizedError {
  readonly label: string;
  // Followed only because the value above was recognized. A foreign error's own
  // cause chain is never walked.
  readonly cause: unknown;
}

export type CauseRecognizer = (value: unknown) => RecognizedError | null;

/** The runtime-wide classifier: every error class this repository owns below
 *  the domain layer, and nothing that names one particular domain. */
export function describeOperationalCause(cause: unknown, depth = 0): string {
  return describeCause(cause, recognizeError, depth);
}

/**
 * The walk itself, over a caller-supplied recognizer.
 *
 * A domain that owns an error class of its own composes a recognizer that tries
 * its class first and falls back to `recognizeError`, then walks with this — so
 * the depth bound, the unrecognized-value fallback, and the two allowlists stay
 * defined exactly once. Recursing through `describeOperationalCause` instead
 * would silently stop recognizing the domain's own class the moment one appeared
 * beneath a runtime error rather than above it.
 */
export function describeCause(value: unknown, recognize: CauseRecognizer, depth = 0): string {
  const recognized = recognize(value);
  if (!recognized) return foreignErrorLabel(value);
  if (depth >= maxCauseDepth) return recognized.label;
  if (recognized.cause === undefined || recognized.cause === null) return recognized.label;
  return `${recognized.label}: ${describeCause(recognized.cause, recognize, depth + 1)}`;
}

// Recognition is by class, never by a `_tag` or `name` field: an arbitrary
// object can set `_tag` to any string it likes, which would reintroduce exactly
// the leak this module prevents.
export function recognizeError(value: unknown): RecognizedError | null {
  if (value instanceof DatabaseError) {
    return { label: `Database operation ${value.operation} failed`, cause: value.cause };
  }
  if (value instanceof PtyServiceError) {
    return {
      label: `PTY service error ${value.code}${coordinates({
        ptyProcess: value.ptyProcessId,
        worktree: value.worktreeId,
      })}`,
      cause: value.cause,
    };
  }
  if (value instanceof PtyStartError) {
    // `command` and `cwd` are deliberately omitted: a resolved command line and
    // a filesystem path are process data, not coordinates.
    return {
      label: `PTY start error${value.reason ? ` ${value.reason}` : ''}${coordinates({
        ptyProcess: value.ptyProcessId,
      })}`,
      cause: value.cause,
    };
  }
  if (value instanceof PtyKillError) {
    return {
      label: `PTY kill error${coordinates({ ptyProcess: value.ptyProcessId })}`,
      cause: value.cause,
    };
  }
  if (value instanceof PtyInspectError) {
    return {
      label: `PTY inspect error${coordinates({ ptyProcess: value.ptyProcessId })}`,
      cause: value.cause,
    };
  }
  if (value instanceof PtyWriteError) {
    return {
      label: `PTY write error${coordinates({ ptyProcess: value.ptyProcessId })}`,
      cause: value.cause,
    };
  }
  if (value instanceof PtyResizeError) {
    return {
      label: `PTY resize error${coordinates({ ptyProcess: value.ptyProcessId })}`,
      cause: value.cause,
    };
  }
  if (value instanceof PtyTerminationInProgressError) {
    return {
      label: `PTY termination already in progress${coordinates({
        ptyProcess: value.ptyProcessId,
      })}`,
      cause: null,
    };
  }
  return null;
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
