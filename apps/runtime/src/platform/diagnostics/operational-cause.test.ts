import assert from 'node:assert/strict';
import test from 'node:test';

import { Schema } from 'effect';

import {
  coordinates,
  describeOperationalCause,
  describeSafely,
  safeSystemErrorCode,
  type SafeDiagnostic,
} from './operational-cause.js';

/**
 * The trust boundary: nothing a user can read may carry a value this codebase
 * did not author.
 *
 * The concrete threat is a corrupt PTY backend ref. Refs can carry a
 * shell-integration token, and Effect Schema renders the offending value when a
 * decode fails — so echoing a decoder's message would publish a secret into a
 * durable, user-visible diagnostic and into logs that end up in bug reports.
 *
 * These are the classifier's own rules, exercised through a local error class
 * that implements the `SafeDiagnostic` protocol the way every runtime error does.
 * The runtime's own labels are tested beside their classes
 * (`platform/persistence/database-error.test.ts`,
 * `pty-processes/tests/safe-diagnostics.test.ts`), and the end-to-end proof that
 * the boundary holds through a real command flow is
 * `commands/tests/diagnostics.redaction.test.ts`.
 */

const SENTINEL = 'SUPERSECRETTOKEN12345';
const SESSION_NAME = 'isagi_testruntime_801';

/** A recognized error: an authored label over authored fields, and a cause to walk. */
class OperationFailed extends Error implements SafeDiagnostic {
  constructor(
    readonly operation: string,
    override readonly cause: unknown,
    message = `${operation} failed`,
    readonly ptyProcessId?: number,
  ) {
    super(message);
  }

  [describeSafely]() {
    return {
      label: `Operation ${this.operation} failed${coordinates({ ptyProcess: this.ptyProcessId })}`,
      cause: this.cause,
    };
  }
}

test('the renderer composes from authored fields and never from foreign text', () => {
  assert.equal(
    describeOperationalCause(new OperationFailed('find_pty_process', new Error(SENTINEL))),
    'Operation find_pty_process failed: Error',
  );

  // A recognized error's own `message` is never read, even though we authored it
  // — two authored messages embed ref-derived values today.
  assert.equal(
    describeOperationalCause(
      new OperationFailed('replay', null, `Could not replay tmux session ${SESSION_NAME}.`, 7),
    ),
    'Operation replay failed (ptyProcess=7)',
  );
});

test('a foreign value cannot name itself', () => {
  // The attack the class-based recognition closes: an arbitrary object claiming
  // to be one of ours, with a secret in the field a tag-based reader would print.
  assert.equal(describeOperationalCause({ _tag: SENTINEL, message: SENTINEL }), 'UnknownError');
  assert.equal(describeOperationalCause(SENTINEL), 'UnknownError');
  assert.equal(describeOperationalCause(null), 'UnknownError');

  // An Error subclass outside the known set is reported as a plain `Error`
  // rather than by a constructor name that could itself carry a value.
  class SUPERSECRETTOKEN12345 extends Error {}
  assert.equal(describeOperationalCause(new SUPERSECRETTOKEN12345('boom')), 'Error');
  assert.equal(describeOperationalCause(new SyntaxError('boom')), 'SyntaxError');
});

test('only the module-local protocol key is recognized, never a look-alike', () => {
  // The protocol key is a module-local `Symbol`, so a value can only claim to be
  // one of ours by importing it. A registered symbol with the same description,
  // or a string key, is just another foreign field.
  const lookAlike = (key: PropertyKey) => ({
    [key]: () => ({ label: SENTINEL, cause: null }),
  });
  assert.equal(
    describeOperationalCause(lookAlike(Symbol.for('isagi.describeSafely'))),
    'UnknownError',
  );
  assert.equal(describeOperationalCause(lookAlike('isagi.describeSafely')), 'UnknownError');
  assert.equal(describeOperationalCause(lookAlike(Symbol('isagi.describeSafely'))), 'UnknownError');
});

test('a schema decode failure is named but its message is never rendered', () => {
  // The proven value-echoing case: Effect Schema puts the offending input in its
  // message. The type is allowlisted by its Effect v4 name (`ParseError` in v3),
  // so a decode failure is still reported as one — and only as one.
  let failure: unknown;
  try {
    Schema.decodeUnknownSync(Schema.Struct({ token: Schema.Number }))({ token: SENTINEL });
  } catch (error: unknown) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.equal(describeOperationalCause(failure), 'SchemaError');
  assert.equal(
    describeOperationalCause(new OperationFailed('decode_ref', failure)),
    'Operation decode_ref failed: SchemaError',
  );
});

test('the cause chain stops at the first foreign link', () => {
  // A foreign error's own cause is never walked: whatever it wraps is outside
  // this codebase's authorship and cannot be vouched for.
  const nested = new Error('outer');
  (nested as { cause?: unknown }).cause = new Error(SENTINEL);
  const rendered = describeOperationalCause(new OperationFailed('kill', nested, 'kill', 801));

  assert.equal(rendered, 'Operation kill failed (ptyProcess=801): Error');
  assert.ok(!rendered.includes(SENTINEL));
});

test('a system error code is carried only from the exact allowlist', () => {
  // The support value this exists for: "System error EADDRINUSE" tells a reader
  // a port was taken; a bare "Error" tells them nothing.
  const inUse = new Error('listen EADDRINUSE: address already in use 127.0.0.1:5173');
  (inUse as { code?: unknown }).code = 'EADDRINUSE';
  const rendered = describeOperationalCause(inUse);
  assert.equal(rendered, 'System error EADDRINUSE');
  // The message carries an address and a port. Neither may appear.
  assert.ok(!rendered.includes('5173'));
  assert.ok(!rendered.includes('127.0.0.1'));

  // An unlisted code is not a code as far as this module is concerned, so the
  // value falls back to its class label. Membership is exact, never a pattern:
  // a pattern over `E[A-Z]+` would admit whatever an unvouched value chose.
  const sentinelCoded = new Error('boom');
  (sentinelCoded as { code?: unknown }).code = `E${SENTINEL}`;
  assert.equal(describeOperationalCause(sentinelCoded), 'Error');
  assert.ok(!describeOperationalCause(sentinelCoded).includes(SENTINEL));

  // A non-string code is ignored rather than stringified.
  const numericCoded = new Error('boom');
  (numericCoded as { code?: unknown }).code = 13;
  assert.equal(describeOperationalCause(numericCoded), 'Error');
});

test('a system error code is read only from an own data property of a real Error', () => {
  // An arbitrary object cannot name itself, code or not — the `instanceof`
  // guard is what stops a plain bag of fields from being treated as an error.
  assert.equal(describeOperationalCause({ code: 'EADDRINUSE' }), 'UnknownError');

  // An accessor is foreign code, and this renderer must never run foreign code.
  // A getter that throws would take down the diagnostic path it was called on;
  // one that returns a value would smuggle it past the allowlist's intent.
  const accessorBacked = new Error('boom');
  let invoked = false;
  Object.defineProperty(accessorBacked, 'code', {
    get() {
      invoked = true;
      throw new Error(SENTINEL);
    },
    configurable: true,
  });
  assert.equal(describeOperationalCause(accessorBacked), 'Error');
  assert.equal(invoked, false, 'the renderer must not invoke an accessor on a foreign value');

  // An inherited `code` is not something this value declared about itself.
  class CodedBase extends Error {}
  Object.defineProperty(CodedBase.prototype, 'code', {
    value: 'EADDRINUSE',
    configurable: true,
  });
  assert.equal(describeOperationalCause(new CodedBase('boom')), 'Error');
});

test('a system error code renders inside a recognized cause chain', () => {
  // The shape the port probe actually produces once Phase 04 persists it:
  // an authored prefix, then the OS constant, and nothing else.
  const bindFailure = new Error('listen EACCES');
  (bindFailure as { code?: unknown }).code = 'EACCES';
  assert.equal(
    describeOperationalCause(new OperationFailed('kill', bindFailure, 'kill', 801)),
    'Operation kill failed (ptyProcess=801): System error EACCES',
  );
});

test('filesystem and spawn failures are named by their system error code', () => {
  // The observed failures behind these entries: a missing executable or file, a full disk on a
  // PTY log append, a busy, read-only or faulty volume under an orphan sweep, and the shape
  // conditions the artifact and data-directory writers hit (ELOOP is an O_NOFOLLOW refusal).
  for (const code of [
    'ENOENT',
    'ENOSPC',
    'EROFS',
    'EBUSY',
    'EIO',
    'ENOTEMPTY',
    'ENAMETOOLONG',
    'ENOTDIR',
    'EISDIR',
    'EEXIST',
    'ELOOP',
  ]) {
    const failure = new Error(`${code}: operation failed, unlink '/Users/${SENTINEL}/x'`);
    (failure as { code?: unknown }).code = code;
    const rendered = describeOperationalCause(failure);
    assert.equal(rendered, `System error ${code}`);
    assert.ok(!rendered.includes(SENTINEL));
  }
});

test('safeSystemErrorCode applies the same exact allowlist', () => {
  assert.equal(safeSystemErrorCode('ENOENT'), 'ENOENT');
  assert.equal(safeSystemErrorCode('EADDRINUSE'), 'EADDRINUSE');
  assert.equal(safeSystemErrorCode(`E${SENTINEL}`), null);
  assert.equal(safeSystemErrorCode(13), null);
  assert.equal(safeSystemErrorCode(null), null);
});
