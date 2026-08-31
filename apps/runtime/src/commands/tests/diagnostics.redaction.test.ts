import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { decodeBackendRef } from '../../pty-processes/service/backend-ref.js';
import { PtyKillError, PtyServiceError } from '../../pty-processes/types.js';
import { describeCommandCause } from '../commands.diagnostics.js';
import { CommandError } from '../commands.errors.js';
import { CommandPortAllocationError } from '../commands.ports.js';
import {
  commandRun,
  commandState,
  createFixture,
  fakePtyProcessRow,
  runCommandScenario,
  writeConfig,
} from './test-support.js';

/**
 * The command domain's half of the trust boundary: the `CommandError`
 * recognizer it owns, and the end-to-end proof that nothing a user can read
 * through a command flow carries a value this codebase did not author. The
 * shared classifier's own rules are tested at
 * `diagnostics/operational-cause.test.ts`.
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

test('the command recognizer names the configured command and nothing it runs', () => {
  assert.equal(
    describeCommandCause(
      new CommandError({
        code: 'command_action_failed',
        message: SENTINEL,
        worktreeId: 10,
        commandName: 'dev',
      }),
    ),
    'Command error command_action_failed (worktree=10, command=dev)',
  );
});

test('the command wrapper stays total over failures it does not own', () => {
  // Every commands call site classifies through this function, including sites
  // that can only receive PTY or database failures today. It must therefore
  // delegate the whole shared vocabulary rather than degrade to a bare label.
  assert.equal(
    describeCommandCause(
      new PtyServiceError({
        code: 'backend_unavailable',
        message: `Could not replay tmux session ${SESSION_NAME}.`,
        ptyProcessId: 7,
      }),
    ),
    'PTY service error backend_unavailable (ptyProcess=7)',
  );
  assert.equal(describeCommandCause({ _tag: SENTINEL, message: SENTINEL }), 'UnknownError');
});

test('a command error is still recognized beneath a runtime error', () => {
  // The composition property the shared walk exists for: the command recognizer
  // applies at every depth, not only at the outermost value.
  const rendered = describeCommandCause(
    new PtyKillError({
      cause: new CommandError({
        code: 'command_action_failed',
        message: SENTINEL,
        worktreeId: 10,
        commandName: 'dev',
      }),
      ptyProcessId: 801,
    }),
  );
  assert.equal(
    rendered,
    'PTY kill error (ptyProcess=801): Command error command_action_failed (worktree=10, command=dev)',
  );
  assert.ok(!rendered.includes(SENTINEL));
});

test('an allocation failure carries only the endpoint name and a rendered cause', async () => {
  const fixture = createFixture();
  // A user-authored environment-variable name plus an OS error whose message
  // would carry the loopback address and port if anything echoed it.
  const nodeError = Object.assign(
    new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${SENTINEL}`),
    {
      code: 'EADDRINUSE',
    },
  );
  writeConfig(
    fixture.rootPath,
    `
commands:
  - name: dev
    command: pnpm dev
    ports:
      - envVar: API_PORT
`,
  );
  try {
    const scenario = await runCommandScenario(
      fixture.rootPath,
      ({ service, recorder }) =>
        Effect.sync(() => recorder.reset()).pipe(
          Effect.zipRight(service.run({ worktreeId: 10, commandName: 'dev' }).pipe(Effect.exit)),
        ),
      {
        portProbe: {
          probeInactive: () => Effect.succeed(false),
          obtainEphemeralPort: Effect.fail(
            new CommandPortAllocationError({ detail: describeCommandCause(nodeError) }),
          ),
        },
      },
    );

    const detail = scenario.recorder.runs.at(-1)?.diagnosticDetail ?? '';
    // The envVar is config-authored and the code comes from the fixed allowlist;
    // between them they say which endpoint failed and why, which is all support
    // needs.
    assert.equal(detail, 'Could not allocate a port for API_PORT: System error EADDRINUSE');
    // The Node message is foreign text. It never reaches the durable diagnostic
    // or the logs, even though the renderer clearly had it in hand.
    assert.ok(!detail.includes(SENTINEL));
    assert.ok(!scenario.recorder.logs.join('\n').includes(SENTINEL));
  } finally {
    fixture.cleanup();
  }
});
