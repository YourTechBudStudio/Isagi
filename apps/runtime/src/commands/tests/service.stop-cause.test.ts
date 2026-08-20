import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause, Effect, Exit } from 'effect';

import { DatabaseError } from '../../persistence/index.js';
import { PtyKillError } from '../../pty-processes/types.js';
import type { CommandRunRow, CommandStateRow } from '../commands.repository.js';
import {
  commandRun,
  commandState,
  createFixture,
  fakePtyProcessRow,
  runCommandScenario,
  waitForLog,
  writeConfig,
  type CommandRepositoryOptions,
  type CommandScenarioRecorder,
} from './test-support.js';

/**
 * The stop matrix: what a stop does depends on who asked for it and on what the
 * process actually did.
 *
 * A stop Isagi performs while leaving a worktree, which verifiably killed a live
 * process, is the *only* thing that mints `suspended`. A person's Stop clears
 * that intent. A process that was already gone binds no cause at all, because
 * nothing this call did ended it. A stop that could not establish process
 * control leaves the command honestly running, with a diagnostic saying so.
 *
 * The single-link invariant is asserted after every scenario: a command state's
 * pointer is null or equals the latest retained run's PTY link.
 */

const config = `
commands:
  - name: dev
    command: pnpm dev
`;

/** Stops a command through the API surface (cause `user`). */
async function stop(
  input: {
    readonly commandName?: string | undefined;
    readonly config?: string | undefined;
    readonly states: CommandStateRow[];
    readonly runs?: CommandRunRow[] | undefined;
  } & Pick<
    CommandRepositoryOptions,
    'pty' | 'ptyProcess' | 'ptyProcessReadFault' | 'finalizeFault' | 'latestRun' | 'readoptFault'
  >,
) {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, input.config ?? config);
  const commandName = input.commandName ?? 'dev';
  try {
    const scenario = await runCommandScenario(
      fixture.rootPath,
      ({ service }) => service.stop({ worktreeId: 10, commandName }).pipe(Effect.exit),
      repositoryOptions(input),
    );
    assertSingleLink(scenario.recorder);
    return scenario;
  } finally {
    fixture.cleanup();
  }
}

/** Leaves the worktree, which is what carries cause `deactivation`. */
async function deactivate(
  input: {
    readonly config?: string | undefined;
    readonly states: CommandStateRow[];
    readonly runs?: CommandRunRow[] | undefined;
  } & Pick<CommandRepositoryOptions, 'pty' | 'ptyProcess' | 'finalizeFault' | 'latestRun'>,
) {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, input.config ?? config);
  try {
    const scenario = await runCommandScenario(
      fixture.rootPath,
      ({ internalEvents, recorder }) =>
        Effect.gen(function* () {
          yield* internalEvents.publish({
            type: 'worktree_activation_change',
            previousWorktreeId: 10,
            nextWorktreeId: null,
            cause: 'active_context_changed',
          });
          yield* waitForLog(recorder, '[runtime] Deactivation suspended');
        }),
      repositoryOptions(input),
    );
    assertSingleLink(scenario.recorder);
    return scenario;
  } finally {
    fixture.cleanup();
  }
}

function repositoryOptions(
  input: {
    readonly states: CommandStateRow[];
    readonly runs?: CommandRunRow[] | undefined;
  } & Pick<
    CommandRepositoryOptions,
    'pty' | 'ptyProcess' | 'ptyProcessReadFault' | 'finalizeFault' | 'latestRun' | 'readoptFault'
  >,
): CommandRepositoryOptions {
  return {
    states: input.states,
    runs: input.runs ?? [],
    ...(input.pty ? { pty: input.pty } : {}),
    ...(input.ptyProcess === undefined ? {} : { ptyProcess: input.ptyProcess }),
    ...(input.ptyProcessReadFault ? { ptyProcessReadFault: input.ptyProcessReadFault } : {}),
    ...(input.finalizeFault ? { finalizeFault: input.finalizeFault } : {}),
    ...(input.latestRun === undefined ? {} : { latestRun: input.latestRun }),
    ...(input.readoptFault ? { readoptFault: input.readoptFault } : {}),
  };
}

/** The pointer is null, or it equals the latest retained run's PTY link. */
function assertSingleLink(recorder: CommandScenarioRecorder) {
  for (const name of new Set(recorder.transitions.map((entry) => entry.commandName))) {
    const pointer = recorder.transitions
      .filter((entry) => entry.commandName === name)
      .at(-1)!.activePtyProcessId;
    if (pointer === null) continue;
    const latest = recorder.runs.filter((run) => run.commandName === name).at(-1);
    assert.equal(
      pointer,
      latest?.ptyProcessId,
      `state pointer for ${name} must equal the latest run's link`,
    );
  }
  // A suspended command never keeps a pointer, and its latest run is `stopped`.
  for (const transition of recorder.transitions.filter((entry) => entry.status === 'suspended')) {
    assert.equal(transition.activePtyProcessId, null);
    const latest = recorder.runs.filter((run) => run.commandName === transition.commandName).at(-1);
    assert.equal(latest?.status, 'stopped');
  }
}

test('an explicit stop of a running command records a user stop', async () => {
  const { result, recorder } = await stop({
    states: [commandState({ commandName: 'dev', status: 'running' })],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }), id: 1 }],
  });

  assert.deepEqual(Exit.isSuccess(result) ? result.value.summary.status : result, 'stopped');
  assert.deepEqual(recorder.terminated, [123]);
  assert.deepEqual(recorder.published, [{ commandName: 'dev', status: 'stopped' }]);
  assert.equal(recorder.runs[0]?.status, 'stopped');
});

test('a deactivation stop of a verified live command suspends it', async () => {
  const { recorder } = await deactivate({
    states: [commandState({ commandName: 'dev', status: 'running' })],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }), id: 1 }],
  });

  assert.deepEqual(recorder.terminated, [123]);
  assert.deepEqual(recorder.published, [{ commandName: 'dev', status: 'suspended' }]);
  assert.deepEqual(recorder.transitions, [
    { commandName: 'dev', status: 'suspended', activePtyProcessId: null },
  ]);
  // The run history stays in run vocabulary: `suspended` is an entity status.
  assert.equal(recorder.runs[0]?.status, 'stopped');
  assert.ok(
    recorder.logs.some((line) =>
      line.includes('Deactivation suspended 1 command(s), considered 0 unconfigured, failed 0'),
    ),
  );
});

test('an explicit stop of a suspended command clears the intent without touching its run', async () => {
  const run = {
    ...commandRun({ commandName: 'dev', status: 'stopped', ptyProcessId: 123 }),
    id: 1,
  };
  const { result, recorder } = await stop({
    states: [commandState({ commandName: 'dev', status: 'suspended' })],
    runs: [run],
  });

  assert.deepEqual(Exit.isSuccess(result) ? result.value.summary.status : result, 'stopped');
  assert.deepEqual(recorder.terminated, []);
  assert.deepEqual(recorder.published, [{ commandName: 'dev', status: 'stopped' }]);
  assert.deepEqual(recorder.runs[0], run);
});

test('an explicit stop clears the intent of a suspended command the config no longer names', async () => {
  const { result, recorder } = await stop({
    commandName: 'old dev',
    states: [commandState({ commandName: 'old dev', status: 'suspended' })],
  });

  assert.deepEqual(Exit.isSuccess(result) ? result.value.summary.status : result, 'stopped');
  assert.deepEqual(recorder.transitions, [
    { commandName: 'old dev', status: 'stopped', activePtyProcessId: null },
  ]);
});

test('a repeated deactivation preserves an existing suspension', async () => {
  const { recorder } = await deactivate({
    states: [commandState({ commandName: 'dev', status: 'suspended' })],
  });

  assert.deepEqual(recorder.terminated, []);
  assert.deepEqual(recorder.transitions, []);
  assert.deepEqual(recorder.published, []);
  assert.ok(recorder.logs.some((line) => line.includes('Deactivation suspended 0 command(s)')));
});

test('a restart of a suspended command consumes the intent and announces only the launch', async () => {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, config);
  try {
    const { recorder } = await runCommandScenario(
      fixture.rootPath,
      ({ service }) => service.restart({ worktreeId: 10, commandName: 'dev' }),
      {
        states: [commandState({ commandName: 'dev', status: 'suspended' })],
        runs: [],
        ptyProcess: fakePtyProcessRow(),
      },
    );

    assert.deepEqual(recorder.published, [{ commandName: 'dev', status: 'running' }]);
    assert.deepEqual(recorder.launched, ['pnpm dev']);
    assert.deepEqual(
      recorder.transitions.map((entry) => entry.status),
      ['stopped', 'running', 'running'],
    );
  } finally {
    fixture.cleanup();
  }
});

test('a stop that finds no process commits nothing and binds no cause', async () => {
  const { result, recorder } = await stop({
    states: [commandState({ commandName: 'dev', status: 'running' })],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }), id: 1 }],
    pty: { terminate: () => Effect.succeed('already_absent' as const) },
  });

  assert.deepEqual(Exit.isSuccess(result) ? result.value.summary.status : result, 'running');
  assert.deepEqual(recorder.transitions, []);
  assert.deepEqual(recorder.published, []);
  assert.equal(recorder.runs[0]?.status, 'running');
});

test('a deactivation that finds no process never suspends it', async () => {
  const { recorder } = await deactivate({
    states: [commandState({ commandName: 'dev', status: 'running' })],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }), id: 1 }],
    pty: { terminate: () => Effect.succeed('already_absent' as const) },
  });

  assert.deepEqual(recorder.transitions, []);
  assert.deepEqual(recorder.published, []);
  assert.ok(recorder.logs.some((line) => line.includes('Deactivation suspended 0 command(s)')));
});

test('a failed stop keeps the command running and records why', async () => {
  const { result, recorder } = await stop({
    states: [commandState({ commandName: 'dev', status: 'running' })],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }), id: 1 }],
    pty: {
      terminate: () =>
        Effect.fail(new PtyKillError({ ptyProcessId: 123, cause: new Error('nope') })),
    },
  });

  assert.ok(Exit.isFailure(result));
  assert.equal(recorder.readopted.length, 1);
  assert.equal(recorder.readopted[0]?.diagnostic?.reason, 'process_control_failed');
  // A person pressed Stop; the detail does not need to explain why it happened,
  // but it does have to carry the backend failure underneath the tagged error —
  // a bare `PtyKillError` diagnoses nothing.
  assert.equal(
    recorder.readopted[0]?.diagnostic?.detail,
    // Composed from fields, never from the error's own text: the diagnostic is
    // durable and user-visible, so it carries coordinates rather than whatever a
    // backend or schema decoder happened to say. See `commands.diagnostics.ts`.
    'Could not stop the process: PTY kill error (ptyProcess=123): Error',
  );
  // Reactivity: the unchanged `running` status is republished so the client
  // refetches the metadata carrying the new diagnostic.
  assert.deepEqual(recorder.published, [{ commandName: 'dev', status: 'running' }]);
  assert.equal(recorder.runs[0]?.status, 'running');
});

test('a failed deactivation stop is logged and leaves the command running', async () => {
  const { recorder } = await deactivate({
    states: [commandState({ commandName: 'dev', status: 'running' })],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }), id: 1 }],
    pty: {
      terminate: () =>
        Effect.fail(new PtyKillError({ ptyProcessId: 123, cause: new Error('nope') })),
    },
  });

  assert.equal(recorder.readopted[0]?.diagnostic?.reason, 'process_control_failed');
  // The detail has to say why the stop happened, or a command that was never
  // touched by the user reads as an unexplained failure.
  assert.equal(
    recorder.readopted[0]?.diagnostic?.detail,
    'Could not stop the process while leaving the worktree: PTY kill error (ptyProcess=123): Error',
  );
  assert.ok(
    recorder.logs.some((line) =>
      line.includes('Deactivation suspended 0 command(s), considered 0 unconfigured, failed 1'),
    ),
  );
});

test('an atomic finalize fault commits nothing and fails the stop', async () => {
  const { result, recorder } = await stop({
    states: [commandState({ commandName: 'dev', status: 'running' })],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }), id: 1 }],
    finalizeFault: () =>
      new DatabaseError({
        operation: 'finalize_worktree_command_run_and_state_by_pty',
        cause: new Error('transaction failed'),
      }),
  });

  assert.ok(Exit.isFailure(result));
  assert.deepEqual(recorder.transitions, []);
  assert.deepEqual(recorder.published, []);
  assert.equal(recorder.runs[0]?.status, 'running');
});

test('a pointerless running state is repaired from its run link before stopping', async () => {
  const { result, recorder } = await stop({
    states: [
      { ...commandState({ commandName: 'dev', status: 'running' }), activePtyProcessId: null },
    ],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 777 }), id: 1 }],
    ptyProcess: fakePtyProcessRow({ id: 777, status: 'running' }),
  });

  assert.deepEqual(Exit.isSuccess(result) ? result.value.summary.status : result, 'stopped');
  // Repaired to the run's own link, then stopped through the ordinary flow.
  assert.deepEqual(recorder.terminated, [777]);
  assert.deepEqual(recorder.transitions, [
    { commandName: 'dev', status: 'running', activePtyProcessId: 777 },
    { commandName: 'dev', status: 'stopped', activePtyProcessId: null },
  ]);
  // The repair itself announces nothing: the status did not change.
  assert.deepEqual(recorder.published, [{ commandName: 'dev', status: 'stopped' }]);
});

test('a pointerless running state over a dead incarnation converges to that incarnation fact', async () => {
  const { result, recorder } = await stop({
    states: [
      { ...commandState({ commandName: 'dev', status: 'running' }), activePtyProcessId: null },
    ],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 777 }), id: 1 }],
    ptyProcess: fakePtyProcessRow({ id: 777, status: 'exited', exitCode: 0 }),
  });

  assert.deepEqual(Exit.isSuccess(result) ? result.value.summary.status : result, 'exited');
  assert.deepEqual(recorder.terminated, []);
  assert.deepEqual(recorder.published, [{ commandName: 'dev', status: 'exited' }]);
  assert.equal(recorder.runs[0]?.status, 'exited');
  // Observed after the fact, so it is a failure of nothing — not a failed launch.
  assert.equal(recorder.runs[0]?.diagnosticReason, null);
});

test('a pointerless running state with nothing to associate is marked failed, never stopped', async () => {
  const { result, recorder } = await stop({
    states: [
      { ...commandState({ commandName: 'dev', status: 'running' }), activePtyProcessId: null },
    ],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running' }), id: 1 }],
  });

  assert.deepEqual(Exit.isSuccess(result) ? result.value.summary.status : result, 'failed');
  assert.deepEqual(
    recorder.transitions.map((entry) => entry.status),
    ['failed'],
  );
  assert.equal(recorder.runs[0]?.diagnosticReason, 'process_control_failed');
});

test('a deactivation of a pointerless running state never manufactures a suspension', async () => {
  const { recorder } = await deactivate({
    states: [
      { ...commandState({ commandName: 'dev', status: 'running' }), activePtyProcessId: null },
    ],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running' }), id: 1 }],
  });

  assert.deepEqual(
    recorder.transitions.map((entry) => entry.status),
    ['failed'],
  );
  assert.ok(recorder.logs.some((line) => line.includes('Deactivation suspended 0 command(s)')));
});

test('an unreadable PTY row during recovery propagates instead of manufacturing a dead end', async () => {
  const { result, recorder } = await stop({
    states: [
      { ...commandState({ commandName: 'dev', status: 'running' }), activePtyProcessId: null },
    ],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 777 }), id: 1 }],
    ptyProcessReadFault: () =>
      new DatabaseError({ operation: 'find_pty_process', cause: new Error('unreadable') }),
  });

  assert.ok(Exit.isFailure(result));
  assert.deepEqual(recorder.transitions, []);
  assert.equal(recorder.runs[0]?.status, 'running');
});

test('a pointerless state over a live incarnation is re-adopted whole, not half-repaired', async () => {
  // Defensive shape: the retained run is already terminal while its PTY row is
  // still live. Repairing only the state pointer would let the deactivation
  // write `suspended` over a run nothing can complete, so ownership is
  // re-adopted as one atomic fact before the stop proceeds.
  const { recorder } = await deactivate({
    states: [
      { ...commandState({ commandName: 'dev', status: 'running' }), activePtyProcessId: null },
    ],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'failed', ptyProcessId: 777 }), id: 1 }],
    ptyProcess: fakePtyProcessRow({ id: 777, status: 'running' }),
  });

  assert.deepEqual(recorder.terminated, [777]);
  assert.equal(recorder.runs[0]?.status, 'stopped');
  assert.deepEqual(recorder.transitions.at(-1), {
    commandName: 'dev',
    status: 'suspended',
    activePtyProcessId: null,
  });
  // The repair itself is silent: only the outcome is announced.
  assert.deepEqual(recorder.published, [{ commandName: 'dev', status: 'suspended' }]);
  // Ordinary repair carries no diagnostic.
  assert.equal(recorder.readopted[0]?.diagnostic, undefined);
});

test('a re-adoption preserves an earlier diagnostic rather than clearing it', async () => {
  // `already_absent` writes nothing, so this is the branch where a preserved
  // diagnostic is observable: it survives until the incarnation's own terminal
  // fact converges.
  const { recorder } = await stop({
    states: [
      { ...commandState({ commandName: 'dev', status: 'running' }), activePtyProcessId: null },
    ],
    runs: [
      {
        ...commandRun({
          commandName: 'dev',
          status: 'failed',
          ptyProcessId: 777,
          diagnosticReason: 'process_control_failed',
          diagnosticDetail: 'earlier evidence',
        }),
        id: 1,
      },
    ],
    ptyProcess: fakePtyProcessRow({ id: 777, status: 'running' }),
    pty: { terminate: () => Effect.succeed('already_absent' as const) },
  });

  assert.equal(recorder.runs[0]?.status, 'running');
  assert.equal(recorder.runs[0]?.diagnosticReason, 'process_control_failed');
  assert.equal(recorder.runs[0]?.diagnosticDetail, 'earlier evidence');
  assert.deepEqual(recorder.published, []);
});

test('a stop whose diagnostic repair also fails propagates the database failure', async () => {
  const { result, recorder } = await stop({
    states: [commandState({ commandName: 'dev', status: 'running' })],
    runs: [{ ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }), id: 1 }],
    pty: {
      terminate: () =>
        Effect.fail(new PtyKillError({ ptyProcessId: 123, cause: new Error('nope') })),
    },
    readoptFault: () =>
      new DatabaseError({
        operation: 'readopt_worktree_command_incarnation',
        cause: new Error('transaction failed'),
      }),
  });

  // The database failure is the honest headline of a double fault, and the
  // repair is authoritative — nothing is published, because nothing committed.
  assert.ok(Exit.isFailure(result));
  assert.ok(Cause.squash(result.cause) instanceof DatabaseError);
  assert.deepEqual(recorder.published, []);
  assert.deepEqual(recorder.transitions, []);
  assert.equal(recorder.runs[0]?.status, 'running');
  assert.equal(recorder.runs[0]?.diagnosticReason, null);
  // The termination failure would otherwise be lost behind the database error.
  assert.ok(recorder.logs.some((line) => line.includes('original termination failure:')));
});
