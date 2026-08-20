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
import { CommandError } from './commands.errors.js';

// The trust boundary between an operational failure and anything a user can
// read.
//
// Command diagnostics are persisted and shown in the product, and command-domain
// logs end up in bug reports, so everything here is written on the assumption
// that it will be read by someone other than the person whose machine produced
// it. That makes the rule strict: a rendered failure is *composed* from fields
// this codebase authored, never copied from an error's own text.
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
// enums, and identifiers (PTY, worktree, configured command name). What may
// never appear: secrets, backend refs or any component of one, environment
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

interface RecognizedError {
  readonly label: string;
  // Followed only because the value above was recognized. A foreign error's own
  // cause chain is never walked.
  readonly cause: unknown;
}

export function describeOperationalCause(cause: unknown, depth = 0): string {
  const recognized = recognizeError(cause);
  if (!recognized) return foreignErrorLabel(cause);
  if (depth >= maxCauseDepth) return recognized.label;
  if (recognized.cause === undefined || recognized.cause === null) return recognized.label;
  return `${recognized.label}: ${describeOperationalCause(recognized.cause, depth + 1)}`;
}

// Recognition is by class, never by a `_tag` or `name` field: an arbitrary
// object can set `_tag` to any string it likes, which would reintroduce exactly
// the leak this module prevents.
function recognizeError(value: unknown): RecognizedError | null {
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
  if (value instanceof CommandError) {
    // The configured command name identifies which command failed. It is a
    // config-authored identifier, not the shell command line it runs.
    return {
      label: `Command error ${value.code}${coordinates({
        worktree: value.worktreeId,
        command: value.commandName,
      })}`,
      cause: value.cause,
    };
  }
  return null;
}

function foreignErrorLabel(value: unknown) {
  if (!(value instanceof Error)) return 'UnknownError';
  const name: unknown = Object.getPrototypeOf(value)?.constructor?.name;
  return typeof name === 'string' && knownForeignErrorNames.has(name) ? name : 'Error';
}

function coordinates(values: Record<string, string | number | undefined>) {
  const parts = Object.entries(values).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${value}`],
  );
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}
