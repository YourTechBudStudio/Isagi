import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { DatabaseError } from '../../persistence/index.js';
import { decodeBackendRef } from '../../pty-processes/service/backend-ref.js';
import { PtyKillError, PtyServiceError } from '../../pty-processes/types.js';
import { describeOperationalCause } from '../commands.diagnostics.js';
import { CommandError } from '../commands.errors.js';
import {
  commandRun,
  commandState,
  createFixture,
  fakePtyProcessRow,
  runCommandScenario,
  writeConfig,
} from './test-support.js';

/**
 * The trust boundary: nothing a user can read may carry a value this codebase
 * did not author.
 *
 * The concrete threat is a corrupt PTY backend ref. Refs can carry a
 * shell-integration token, and Effect Schema renders the offending value when a
 * decode fails — so echoing a decoder's message would publish a secret into a
 * durable, user-visible diagnostic and into logs that end up in bug reports.
 *
 * The two sentinel scenarios below use the shapes that **actually** echo a
 * value. This matters: a corrupt ref built from a *missing field* or from
 * garbage JSON renders no value even without the fix, so a test written that way
 * would pass vacuously and prove nothing. Do not "simplify" these fixtures.
 */

const SENTINEL = 'SUPERSECRETTOKEN12345';
const SESSION_NAME = 'isagi_testruntime_801';

const config = `
commands:
  - name: dev
    command: pnpm dev
`;

// A ref that parses as JSON but fails the schema on a *literal* mismatch, which
// is the case that renders `actual "<value>"`.
const refEchoingSentinel = JSON.stringify({
  schemaVersion: 1,
  backend: SENTINEL,
  sessionName: SESSION_NAME,
  shellIntegrationToken: SENTINEL,
});

async function auditWithFailure(pty: {
  readonly cleanupProcess: () => Effect.Effect<never, PtyServiceError | PtyKillError>;
  readonly row: ReturnType<typeof fakePtyProcessRow>;
}) {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, config);
  try {
    const scenario = await runCommandScenario(
      fixture.rootPath,
      ({ service, recorder }) =>
        Effect.sync(() => recorder.reset()).pipe(
          Effect.zipRight(
            service.cleanupBeforeWorktreeDelete({ worktreeId: 10 }).pipe(Effect.exit),
          ),
        ),
      {
        states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 801 })],
        runningStates: [],
        runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 801 })],
        ptyProcess: pty.row,
        pty: { cleanupProcess: pty.cleanupProcess },
      },
    );
    return {
      logs: scenario.recorder.logs.join('\n'),
      // The durable, user-visible field: re-adoption writes the rendered cause
      // into the run's diagnostic detail.
      detail: scenario.recorder.readopted[0]?.diagnostic?.detail ?? '',
    };
  } finally {
    fixture.cleanup();
  }
}

test('a schema decode that echoes a ref value reaches neither logs nor durable diagnostics', async () => {
  // Prove the fixture is genuinely a leaking shape before asserting the fix:
  // Effect Schema really does render the offending value here.
  const rawDecodeFailure = await Effect.runPromise(
    Effect.flip(
      decodeBackendRef({
        id: 801,
        backend: 'tmux',
        backendRefJson: refEchoingSentinel,
      } as never),
    ),
  );
  const rawSchemaMessage = String((rawDecodeFailure as { readonly cause?: unknown }).cause);
  assert.ok(
    rawSchemaMessage.includes(SENTINEL),
    'fixture must use a shape that actually echoes the value, or this test is vacuous',
  );

  const result = await auditWithFailure({
    row: fakePtyProcessRow({ id: 801, backend: 'tmux', status: 'running' }),
    cleanupProcess: () =>
      Effect.fail(
        new PtyServiceError({
          code: 'backend_session_missing',
          message: `PTY process 801 has an invalid or unsupported backend ref.`,
          ptyProcessId: 801,
          cause: rawDecodeFailure,
        }),
      ) as Effect.Effect<never, PtyServiceError>,
  });

  assert.ok(!result.logs.includes(SENTINEL), 'the sentinel must not reach command-domain logs');
  assert.ok(!result.detail.includes(SENTINEL), 'the sentinel must not reach durable diagnostics');
  // A backend ref component is protected even though it is not itself a secret.
  assert.ok(!result.logs.includes(SESSION_NAME));
  assert.ok(!result.detail.includes(SESSION_NAME));
  // The coordinates that make the failure diagnosable are still there.
  assert.ok(result.logs.includes('ptyProcessId=801'));
  assert.ok(result.logs.includes('backend=tmux'));
  assert.match(result.detail, /backend_session_missing/);
});

test('a foreign backend error message reaches neither logs nor durable diagnostics', async () => {
  const result = await auditWithFailure({
    row: fakePtyProcessRow({ id: 801, backend: 'tmux', status: 'running' }),
    cleanupProcess: () =>
      Effect.fail(
        new PtyKillError({
          // Real backends put their stderr here, which is arbitrary foreign text.
          cause: new Error(`tmux: kill-session ${SESSION_NAME} failed: ${SENTINEL}`),
          ptyProcessId: 801,
        }),
      ) as Effect.Effect<never, PtyKillError>,
  });

  assert.ok(!result.logs.includes(SENTINEL));
  assert.ok(!result.detail.includes(SENTINEL));
  assert.ok(!result.logs.includes(SESSION_NAME));
  assert.ok(!result.detail.includes(SESSION_NAME));
  assert.ok(result.logs.includes('ptyProcessId=801'));
});

test('the renderer composes from authored fields and never from foreign text', () => {
  assert.equal(
    describeOperationalCause(
      new DatabaseError({ operation: 'find_pty_process', cause: new Error(SENTINEL) }),
    ),
    'Database operation find_pty_process failed: Error',
  );

  assert.equal(
    describeOperationalCause(
      new CommandError({
        code: 'command_action_failed',
        message: SENTINEL,
        worktreeId: 10,
        commandName: 'dev',
      }),
    ),
    'Command error command_action_failed (worktree=10, command=dev)',
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
