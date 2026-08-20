import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { DatabaseError } from '../../persistence/index.js';
import { PtyServiceError } from '../../pty-processes/types.js';
import { terminalCommandOutcomeForPtyRow } from '../commands.outcomes.js';
import type { CommandRunRow, CommandStateRow } from '../commands.repository.js';
import {
  commandRun,
  commandState,
  createFixture,
  fakePtyProcessRow,
  runCommandScenario,
  writeConfig,
  type CommandRepositoryOptions,
  type CommandScenarioRecorder,
} from './test-support.js';

/**
 * Boot convergence: what the runtime concludes about its commands after it was
 * interrupted.
 *
 * The rule the whole pass exists to enforce is that a command's record is only
 * changed *after* its processes have been accounted for. Nothing here may mark
 * a process gone on the strength of a stale status row, and nothing here may
 * start anything — a suspended command waits for the user to come back.
 *
 * Boot runs during service construction, so every scenario below simply builds
 * the service and then reads what it did.
 */

const config = `
commands:
  - name: dev
    command: pnpm dev
`;

async function boot(
  input: {
    readonly states: CommandStateRow[];
    readonly runs?: CommandRunRow[] | undefined;
    readonly config?: string | undefined;
  } & Pick<
    CommandRepositoryOptions,
    'pty' | 'ptyProcess' | 'ptyProcessById' | 'ptyProcessReadFault' | 'readoptFault'
  >,
): Promise<{
  readonly recorder: CommandScenarioRecorder;
  readonly runs: CommandRunRow[];
}> {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, input.config ?? config);
  try {
    const scenario = await runCommandScenario(fixture.rootPath, () => Effect.void, {
      states: input.states,
      runningStates: input.states.filter((state) => state.status === 'running'),
      runs: input.runs ?? [],
      ...(input.pty ? { pty: input.pty } : {}),
      ...(input.ptyProcess !== undefined ? { ptyProcess: input.ptyProcess } : {}),
      ...(input.ptyProcessById ? { ptyProcessById: input.ptyProcessById } : {}),
      ...(input.ptyProcessReadFault ? { ptyProcessReadFault: input.ptyProcessReadFault } : {}),
      ...(input.readoptFault ? { readoptFault: input.readoptFault } : {}),
    });
    // State rows live inside the fake repository, so what boot did to them is
    // read from the recorded transitions rather than from the seed array.
    return { recorder: scenario.recorder, runs: scenario.recorder.runs };
  } finally {
    fixture.cleanup();
  }
}

const unavailable = (ptyProcessId: number) =>
  new PtyServiceError({
    code: 'backend_unavailable',
    message: 'PTY backend tmux is unavailable.',
    ptyProcessId,
  });

test('an ordinary crash leaves the command failed with the interruption diagnostic', async () => {
  // The common case: the state still says running, and the incarnation's row is
  // already terminal because the PTY layer's own startup reconciliation got to
  // it first. Nothing survives, so there is nothing to clean up.
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 123 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 })],
    ptyProcess: fakePtyProcessRow({
      id: 123,
      status: 'failed',
      statusReason: 'runtime_ephemeral_lost',
    }),
  });

  assert.deepEqual(result.recorder.cleaned, [], 'a terminal row is not a boot candidate');
  assert.equal(result.runs[0]?.status, 'failed');
  assert.equal(result.runs[0]?.diagnosticReason, 'runtime_stopped');
  assert.equal(
    result.runs[0]?.diagnosticDetail,
    'Runtime stopped while this command was running. Not restarted.',
  );
  assert.deepEqual(result.recorder.transitions, [
    { commandName: 'dev', status: 'failed', activePtyProcessId: null },
  ]);
  assert.ok(result.recorder.published.some((event) => event.status === 'failed'));
});

test('a running state over an already-terminal run is repaired to that run’s own outcome', async () => {
  // The run already knows the command exited cleanly. Writing a bare `failed`
  // over it would invent a failure that never happened.
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 123 })],
    runs: [commandRun({ commandName: 'dev', status: 'exited', ptyProcessId: 123 })],
    ptyProcess: fakePtyProcessRow({ id: 123, status: 'exited', exitCode: 0 }),
  });

  assert.equal(result.runs[0]?.status, 'exited');
  assert.equal(result.runs[0]?.diagnosticReason, null);
  assert.deepEqual(result.recorder.transitions, [
    { commandName: 'dev', status: 'exited', activePtyProcessId: null },
  ]);
  assert.ok(result.recorder.published.some((event) => event.status === 'exited'));
});

test('a surviving incarnation is cleaned up through the shutdown reason', async () => {
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 501 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 501 })],
    ptyProcess: fakePtyProcessRow({ id: 501, backend: 'tmux', status: 'running' }),
    pty: { cleanupProcess: () => Effect.succeed('terminated' as const) },
  });

  assert.deepEqual(result.recorder.cleaned, [
    { ptyProcessId: 501, reason: 'runtime_shutdown', ensureBackendAbsence: false },
  ]);
  // Boot never issues the deletion audit's gating kill: at startup there is no
  // cascade about to erase the row, and the poller still owns late convergence.
  assert.equal(result.runs[0]?.status, 'failed');
  assert.equal(result.runs[0]?.diagnosticReason, 'runtime_stopped');
  assert.deepEqual(result.recorder.transitions, [
    { commandName: 'dev', status: 'failed', activePtyProcessId: null },
  ]);
});

test('a terminal-state command with a live linked incarnation is drained without touching its record', async () => {
  // A legacy row whose command already ended, but whose tmux session outlived
  // the runtime. The process must go; the record was already true.
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'exited', activePtyProcessId: null })],
    runs: [commandRun({ commandName: 'dev', status: 'exited', ptyProcessId: 501 })],
    ptyProcess: fakePtyProcessRow({ id: 501, backend: 'tmux', status: 'running' }),
    pty: { cleanupProcess: () => Effect.succeed('terminated' as const) },
  });

  assert.deepEqual(result.recorder.cleaned, [
    { ptyProcessId: 501, reason: 'runtime_shutdown', ensureBackendAbsence: false },
  ]);
  assert.equal(result.runs[0]?.status, 'exited');
  assert.deepEqual(result.recorder.transitions, [], 'no command row may be rewritten here');
});

test('one command appearing in both workset halves is reconciled once', async () => {
  // The state pointer and the retained run name the same incarnation, which is
  // the ordinary shape. Cleaning it twice would mean two kill attempts and two
  // chances to misattribute an outcome.
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 501 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 501 })],
    ptyProcess: fakePtyProcessRow({ id: 501, backend: 'tmux', status: 'running' }),
    pty: { cleanupProcess: () => Effect.succeed('terminated' as const) },
  });

  assert.equal(result.recorder.cleaned.length, 1);
});

test('a single unresolved incarnation is re-adopted and always announced', async () => {
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 501 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 501 })],
    ptyProcess: fakePtyProcessRow({ id: 501, backend: 'tmux', status: 'running' }),
    pty: { cleanupProcess: () => Effect.fail(unavailable(501)) },
  });

  assert.equal(result.recorder.readopted.length, 1);
  assert.equal(result.recorder.readopted[0]?.ptyProcessId, 501);
  assert.equal(result.recorder.readopted[0]?.diagnostic?.reason, 'process_control_failed');
  assert.match(
    result.recorder.readopted[0]?.diagnostic?.detail ?? '',
    /^Could not stop or verify this command's recorded process after a runtime restart: /,
  );
  // Published even though the status did not move: the same primitive runs
  // during worktree deletion, where a client is connected and the diagnostic
  // only reaches it through this event.
  assert.ok(result.recorder.published.some((event) => event.status === 'running'));
  // The command stays honestly running rather than being declared failed over a
  // process nobody could verify.
  assert.notEqual(result.runs[0]?.status, 'failed');
});

test('a re-adoption with no retained run still takes ownership', async () => {
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 501 })],
    runs: [],
    ptyProcess: fakePtyProcessRow({ id: 501, backend: 'tmux', status: 'running' }),
    pty: { cleanupProcess: () => Effect.fail(unavailable(501)) },
  });

  assert.equal(result.recorder.readopted.length, 1);
  assert.equal(result.recorder.readopted[0]?.ptyProcessId, 501);
});

test('out-of-model divergence is logged and left completely unrepaired', async () => {
  // Pointer names A, the retained run names B, both nonterminal, both
  // unresolvable. Re-adoption binds one and would erase the last durable link to
  // the other — possibly to a live process. Draining is the only safe move.
  const rows = new Map([
    [601, fakePtyProcessRow({ id: 601, backend: 'tmux', status: 'running' })],
    [602, fakePtyProcessRow({ id: 602, backend: 'tmux', status: 'running' })],
  ]);
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 601 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 602 })],
    ptyProcessById: (id) => rows.get(id) ?? null,
    pty: { cleanupProcess: (input) => Effect.fail(unavailable(input.ptyProcessId)) },
  });

  assert.equal(result.recorder.cleaned.length, 2, 'every candidate is still attempted');
  assert.equal(result.recorder.readopted.length, 0);
  assert.deepEqual(result.recorder.transitions, []);
  assert.equal(result.runs[0]?.ptyProcessId, 602, 'both links survive for the next retry');
  assert.equal(result.runs[0]?.status, 'running');
  // The log is the only artifact this branch produces, so it has to name every
  // incarnation *and* its transport — "tmux is uninstalled" and "this ref is
  // corrupt" are different user problems with different recoveries.
  assert.ok(
    result.recorder.logs.some(
      (line) =>
        line.includes('multiple unrepairable incarnations') &&
        line.includes('incarnations=601/tmux/unresolved,602/tmux/unresolved'),
    ),
  );
});

test('an unreadable linked row is treated as unresolved rather than as a dead process', async () => {
  let reads = 0;
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 501 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 501 })],
    ptyProcess: fakePtyProcessRow({ id: 501, backend: 'tmux', status: 'running' }),
    ptyProcessReadFault: () => {
      reads += 1;
      return reads === 1
        ? new DatabaseError({ operation: 'boot_convergence', cause: new Error('unavailable') })
        : null;
    },
    pty: { cleanupProcess: () => Effect.succeed('terminated' as const) },
  });

  // A read that failed says nothing about the process, so the link stays in the
  // workset and is cleaned up anyway.
  assert.equal(result.recorder.cleaned.length, 1);
  assert.ok(result.recorder.logs.some((line) => line.includes('treating it as unresolved')));
});

test('a suspended command is left completely alone and nothing is launched', async () => {
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'suspended' })],
    runs: [commandRun({ commandName: 'dev', status: 'stopped', ptyProcessId: null })],
  });

  assert.deepEqual(result.recorder.cleaned, []);
  assert.deepEqual(result.recorder.transitions, []);
  assert.deepEqual(
    result.recorder.launched,
    [],
    'restarting the runtime is not the user returning',
  );
  assert.equal(result.runs[0]?.status, 'stopped');
});

test('a linkless running run under a non-running state is closed by the residue sweep', async () => {
  // The only flow that produces this: a launch that hit a database fault before
  // it could write its own marker, so the run exists, names no incarnation, and
  // the command never became running.
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'idle' })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: null })],
  });

  assert.equal(result.runs[0]?.status, 'failed');
  assert.equal(result.runs[0]?.diagnosticReason, 'pty_launch_failed');
  assert.equal(result.runs[0]?.diagnosticDetail, 'The launch never started a process.');
  // Boot precedes client connections and no entity state changed, so there is
  // nothing to invalidate.
  assert.deepEqual(result.recorder.published, []);
  assert.deepEqual(result.recorder.transitions, []);
});

test('the residue sweep cannot undo a re-adoption', async () => {
  // Re-adoption's output is always linked *and* running-stated, which is exactly
  // what the sweep's three predicates exclude. This pins that disjointness
  // rather than relying on the two running in a particular order.
  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 501 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 501 })],
    ptyProcess: fakePtyProcessRow({ id: 501, backend: 'tmux', status: 'running' }),
    pty: { cleanupProcess: () => Effect.fail(unavailable(501)) },
  });

  assert.equal(result.recorder.readopted.length, 1);
  assert.equal(result.runs[0]?.status, 'running');
  assert.equal(result.runs[0]?.ptyProcessId, 501);
});

test('one command’s convergence failure does not abort the pass', async () => {
  const rows = new Map([
    [701, fakePtyProcessRow({ id: 701, backend: 'tmux', status: 'running' })],
    [702, fakePtyProcessRow({ id: 702, backend: 'tmux', status: 'running' })],
  ]);
  const result = await boot({
    config: `
commands:
  - name: dev
    command: pnpm dev
  - name: api
    command: pnpm api
`,
    states: [
      commandState({ commandName: 'dev', status: 'running', id: 1, activePtyProcessId: 701 }),
      commandState({ commandName: 'api', status: 'running', id: 2, activePtyProcessId: 702 }),
    ],
    runs: [
      commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 701, id: 1 }),
      commandRun({ commandName: 'api', status: 'running', ptyProcessId: 702, id: 2 }),
    ],
    ptyProcessById: (id) => rows.get(id) ?? null,
    pty: { cleanupProcess: () => Effect.fail(unavailable(0)) },
    readoptFault: () =>
      new DatabaseError({ operation: 'boot_convergence', cause: new Error('unavailable') }),
  });

  // Both commands were visited even though each one's repair write failed.
  assert.equal(result.recorder.cleaned.length, 2);
  assert.ok(result.recorder.logs.some((line) => line.includes('Command boot convergence failed')));
});

test('boot writes exactly what the shutdown event path writes', async () => {
  // Which of the two orderings recorded the interruption — the subscriber
  // seeing the shutdown kill, or boot finding the wreckage afterwards — must be
  // invisible to the user. The event path's own end-to-end coverage lives in
  // `service.run.test.ts`; deriving the expectation here from the shared mapper
  // is what stops the two from drifting apart in a later edit.
  const viaEvent = terminalCommandOutcomeForPtyRow(
    { status: 'killed', statusReason: 'runtime_shutdown' },
    'event',
  );

  const result = await boot({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 123 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 })],
    ptyProcess: fakePtyProcessRow({ id: 123, status: 'killed', statusReason: 'runtime_shutdown' }),
  });

  assert.equal(result.runs[0]?.status, viaEvent.runStatus);
  assert.equal(result.runs[0]?.diagnosticReason, viaEvent.diagnostic?.reason);
  assert.equal(result.runs[0]?.diagnosticDetail, viaEvent.diagnostic?.detail);
});
