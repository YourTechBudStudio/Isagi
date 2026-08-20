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
