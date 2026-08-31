import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseError } from '../persistence/index.js';
import { PtyKillError, PtyServiceError } from '../pty-processes/types.js';
import { describeOperationalCause } from './operational-cause.js';

/**
 * The trust boundary: nothing a user can read may carry a value this codebase
 * did not author.
 *
 * The concrete threat is a corrupt PTY backend ref. Refs can carry a
 * shell-integration token, and Effect Schema renders the offending value when a
 * decode fails — so echoing a decoder's message would publish a secret into a
 * durable, user-visible diagnostic and into logs that end up in bug reports.
 *
 * These are the classifier's own rules. The command domain's wrapper adds one
 * recognizer on top and is tested beside it, in
 * `commands/tests/diagnostics.redaction.test.ts`, together with the end-to-end
 * proof that the boundary holds through a real command flow.
 */

const SENTINEL = 'SUPERSECRETTOKEN12345';
const SESSION_NAME = 'isagi_testruntime_801';

test('the renderer composes from authored fields and never from foreign text', () => {
  assert.equal(
    describeOperationalCause(
      new DatabaseError({ operation: 'find_pty_process', cause: new Error(SENTINEL) }),
    ),
    'Database operation find_pty_process failed: Error',
  );

  // A recognized error's own `message` is never read, even though we authored it
  // — two authored messages embed ref-derived values today.
  assert.equal(
    describeOperationalCause(
      new PtyServiceError({
        code: 'backend_unavailable',
        message: `Could not replay tmux session ${SESSION_NAME}.`,
        ptyProcessId: 7,
      }),
    ),
    'PTY service error backend_unavailable (ptyProcess=7)',
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

test('the cause chain stops at the first foreign link', () => {
  // A foreign error's own cause is never walked: whatever it wraps is outside
  // this codebase's authorship and cannot be vouched for.
  const nested = new Error('outer');
  (nested as { cause?: unknown }).cause = new Error(SENTINEL);
  const rendered = describeOperationalCause(new PtyKillError({ cause: nested, ptyProcessId: 801 }));

  assert.equal(rendered, 'PTY kill error (ptyProcess=801): Error');
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
    describeOperationalCause(new PtyKillError({ cause: bindFailure, ptyProcessId: 801 })),
    'PTY kill error (ptyProcess=801): System error EACCES',
  );
});
