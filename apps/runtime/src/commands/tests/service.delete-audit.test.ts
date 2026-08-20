import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Exit } from 'effect';

import { PtyKillError, PtyServiceError } from '../../pty-processes/types.js';
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
 * The last gate before a worktree's rows are cascaded away.
 *
 * Stopping the commands the runtime believes are running is not enough to
 * conclude that no process survives the delete: a link outlives its command's
 * status, and a backend session can outlive its row. So every incarnation the
 * worktree's commands still refer to is audited, and the delete completes only
 * when each one is terminated here or verified absent.
 *
 * The two failure classes stay strictly separate. A *nonterminal* cleanup
 * failure means something may still be alive and the command should go on owning
 * it — that is the one repair candidate. A *terminal* row's gating kill failing
 * means only that absence could not be verified; the command's record is already
 * true, so it is left untouched and the delete is simply refused.
 */

const config = `
commands:
  - name: dev
    command: pnpm dev
`;

async function audit(
  input: {
    readonly states?: CommandStateRow[] | undefined;
    readonly runs?: CommandRunRow[] | undefined;
    readonly prune?: boolean | undefined;
    readonly config?: string | undefined;
  } & Pick<CommandRepositoryOptions, 'pty' | 'ptyProcess' | 'ptyProcessById'>,
): Promise<{
  readonly exit: Exit.Exit<void, unknown>;
  readonly recorder: CommandScenarioRecorder;
  readonly runs: CommandRunRow[];
}> {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, input.config ?? config);
  try {
    const scenario = await runCommandScenario(
      fixture.rootPath,
      ({ service, recorder }) =>
        // Boot convergence already ran during construction. Everything recorded
        // below therefore belongs to the delete itself.
        Effect.sync(() => recorder.reset()).pipe(
          Effect.zipRight(
            (input.prune
              ? service.cleanupBeforeWorktreePrune({ worktreeId: 10 })
              : service.cleanupBeforeWorktreeDelete({ worktreeId: 10 })
            ).pipe(Effect.exit),
          ),
        ),
      {
        states: input.states ?? [],
        // Empty on purpose: these scenarios are about the audit, not about the
        // ordinary stop sweep that runs before it.
        runningStates: [],
        runs: input.runs ?? [],
        ...(input.pty ? { pty: input.pty } : {}),
        ...(input.ptyProcess !== undefined ? { ptyProcess: input.ptyProcess } : {}),
        ...(input.ptyProcessById ? { ptyProcessById: input.ptyProcessById } : {}),
      },
    );
    return {
      exit: scenario.result as Exit.Exit<void, unknown>,
      recorder: scenario.recorder,
      runs: scenario.recorder.runs,
    };
  } finally {
    fixture.cleanup();
  }
}

function failureCode(exit: Exit.Exit<void, unknown>) {
  if (Exit.isSuccess(exit)) return null;
  const error = exit.cause._tag === 'Fail' ? exit.cause.error : null;
  return (error as { readonly code?: string } | null)?.code ?? null;
}

test('every command-linked incarnation is audited with a gating absence check', async () => {
  const rows = new Map([
    [801, fakePtyProcessRow({ id: 801, backend: 'tmux', status: 'running' })],
    [802, fakePtyProcessRow({ id: 802, backend: 'tmux', status: 'exited' })],
  ]);
  const result = await audit({
    // `dev` is stopped by the ordinary preDelete pass first, which clears its
    // state pointer — and its run link is exactly the reference that would
    // otherwise be forgotten. `api` is a command whose row is already terminal.
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 801 })],
    runs: [
      commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 801, id: 1 }),
      commandRun({ commandName: 'api', status: 'exited', ptyProcessId: 802, id: 2 }),
    ],
    ptyProcessById: (id) => rows.get(id) ?? null,
    pty: { cleanupProcess: () => Effect.succeed('already_terminal' as const) },
  });

  assert.equal(Exit.isSuccess(result.exit), true);
  // The flag is set for every link, not only the ones that currently look
  // terminal: a row that goes terminal between the read and the cleanup would
  // otherwise skip its gating kill and let a late session survive the cascade.
  assert.deepEqual(result.recorder.cleaned, [
    { ptyProcessId: 801, reason: 'user_requested', ensureBackendAbsence: true },
    { ptyProcessId: 802, reason: 'user_requested', ensureBackendAbsence: true },
  ]);
});

test('the audit does not stop at the first failure', async () => {
  const rows = new Map([
    [801, fakePtyProcessRow({ id: 801, backend: 'tmux', status: 'running' })],
    [802, fakePtyProcessRow({ id: 802, backend: 'tmux', status: 'running' })],
  ]);
  const result = await audit({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 801 })],
    runs: [commandRun({ commandName: 'api', status: 'running', ptyProcessId: 802 })],
    ptyProcessById: (id) => rows.get(id) ?? null,
    pty: {
      cleanupProcess: (callInput) =>
        callInput.ptyProcessId === 801
          ? Effect.fail(new PtyKillError({ cause: new Error('tmux refused to kill the session') }))
          : Effect.succeed('terminated' as const),
    },
  });

  // A delete that stopped at the first failure would leave the user unable to
  // tell whether the second command's process is still running.
  assert.equal(result.recorder.cleaned.length, 2);
  assert.equal(failureCode(result.exit), 'command_action_failed');
});

test('a nonterminal survivor is re-adopted with the cleanup wording so a retry can stop it', async () => {
  const result = await audit({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 801 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 801 })],
    ptyProcess: fakePtyProcessRow({ id: 801, backend: 'tmux', status: 'running' }),
    pty: {
      cleanupProcess: () =>
        Effect.fail(
          new PtyServiceError({
            code: 'backend_unavailable',
            message: 'PTY backend tmux is unavailable.',
            ptyProcessId: 801,
          }),
        ),
    },
  });

  assert.equal(result.recorder.readopted.length, 1);
  assert.equal(result.recorder.readopted[0]?.ptyProcessId, 801);
  assert.match(
    result.recorder.readopted[0]?.diagnostic?.detail ?? '',
    /^Could not stop the process during worktree cleanup: /,
  );
  // Clients are connected during a delete, so the diagnostic only reaches them
  // through this event.
  assert.ok(result.recorder.published.some((event) => event.status === 'running'));
  assert.equal(failureCode(result.exit), 'command_action_failed');
});

test('a terminal row whose gating kill fails aborts the delete without reopening the command', async () => {
  const result = await audit({
    states: [commandState({ commandName: 'dev', status: 'exited', activePtyProcessId: null })],
    runs: [commandRun({ commandName: 'dev', status: 'exited', ptyProcessId: 801 })],
    ptyProcess: fakePtyProcessRow({ id: 801, backend: 'tmux', status: 'exited' }),
    pty: {
      cleanupProcess: () => Effect.fail(new PtyKillError({ cause: new Error('tmux is unusable') })),
    },
  });

  assert.equal(failureCode(result.exit), 'command_action_failed');
  // The command already recorded how this incarnation ended. All the audit
  // learned is that it could not verify absence — which is a reason to refuse
  // the delete, never a reason to claim the command is running again.
  assert.deepEqual(result.recorder.readopted, []);
  assert.deepEqual(result.recorder.transitions, []);
  assert.deepEqual(result.recorder.published, []);
  assert.equal(result.runs[0]?.status, 'exited');
  // Because this branch writes nothing durable, the log is the only place the
  // user's bug report can carry which transport could not be verified.
  assert.ok(
    result.recorder.logs.some(
      (line) =>
        line.includes('Command incarnation cleanup failed') &&
        line.includes('backend=tmux') &&
        line.includes('classification=terminal_gated'),
    ),
  );
});

test('a row that cannot be classified after its failure is gated, never repaired', async () => {
  const result = await audit({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 801 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 801 })],
    // The row is gone by the time the classifying read runs.
    ptyProcess: null,
    pty: {
      cleanupProcess: () => Effect.fail(new PtyKillError({ cause: new Error('tmux is unusable') })),
    },
  });

  assert.equal(failureCode(result.exit), 'command_action_failed');
  assert.deepEqual(result.recorder.readopted, [], 'no conclusion means no repair');
});

test('out-of-model divergence during a delete mutates nothing and still refuses', async () => {
  const rows = new Map([
    [901, fakePtyProcessRow({ id: 901, backend: 'tmux', status: 'running' })],
    [902, fakePtyProcessRow({ id: 902, backend: 'tmux', status: 'running' })],
  ]);
  const result = await audit({
    // `preDelete.stop: false` keeps the ordinary stop pass out of the way, so
    // the divergent pair reaches the audit exactly as the database holds it.
    config: `
commands:
  - name: dev
    command: pnpm dev
    lifecycle:
      preDelete:
        stop: false
`,
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 901 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 902 })],
    ptyProcessById: (id) => rows.get(id) ?? null,
    pty: {
      cleanupProcess: () => Effect.fail(new PtyKillError({ cause: new Error('tmux is unusable') })),
    },
  });

  assert.equal(result.recorder.cleaned.length, 2);
  assert.deepEqual(result.recorder.readopted, []);
  assert.deepEqual(result.recorder.transitions, []);
  assert.equal(result.runs[0]?.ptyProcessId, 902, 'every link survives for the retry');
  assert.equal(failureCode(result.exit), 'command_action_failed');
  assert.ok(
    result.recorder.logs.some((line) => line.includes('multiple unrepairable incarnations')),
  );
});

test('a mixed failure set preserves every link instead of repairing one of them', async () => {
  // One nonterminal incarnation (901, the state pointer) and one terminal one
  // whose gating kill failed (902, the only remaining link, held by the run).
  // Re-adopting 901 would repoint that run at it and erase the last reference
  // to 902 — whose backend session nobody was able to verify as gone.
  const rows = new Map([
    [901, fakePtyProcessRow({ id: 901, backend: 'tmux', status: 'running' })],
    [902, fakePtyProcessRow({ id: 902, backend: 'tmux', status: 'exited' })],
  ]);
  const result = await audit({
    config: `
commands:
  - name: dev
    command: pnpm dev
    lifecycle:
      preDelete:
        stop: false
`,
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 901 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 902 })],
    ptyProcessById: (id) => rows.get(id) ?? null,
    pty: {
      // Killing works; verifying absence does not. Only the delete audit asks
      // for the gating check, so boot convergence resolves 901 cleanly and both
      // links reach the audit exactly as the database holds them.
      cleanupProcess: (callInput) =>
        callInput.ensureBackendAbsence
          ? Effect.fail(new PtyKillError({ cause: new Error('tmux is unusable') }))
          : Effect.succeed('terminated' as const),
    },
  });

  assert.equal(result.recorder.cleaned.length, 2);
  assert.deepEqual(result.recorder.readopted, [], 'a mixed failure set is never repaired');
  assert.deepEqual(result.recorder.transitions, []);
  assert.equal(result.runs[0]?.ptyProcessId, 902, 'the only link to 902 survives');
  assert.equal(failureCode(result.exit), 'command_action_failed');
  // Both incarnations stay discoverable, so the next audit re-checks each one.
  assert.deepEqual(
    result.recorder.cleaned.map((call) => call.ptyProcessId).sort((a, b) => a - b),
    [901, 902],
  );
});

test('a retry after the survivor is gone completes the delete', async () => {
  // The user reinstalled the backend, or the session finally died. The link is
  // still there — nothing ever removed it — so the retry finds and clears it.
  const result = await audit({
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 801 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 801 })],
    ptyProcess: fakePtyProcessRow({ id: 801, backend: 'tmux', status: 'running' }),
    pty: { cleanupProcess: () => Effect.succeed('terminated' as const) },
  });

  assert.equal(Exit.isSuccess(result.exit), true);
  assert.equal(result.recorder.cleaned.length, 1);
});

test('prune audits the same links as delete', async () => {
  const result = await audit({
    prune: true,
    states: [commandState({ commandName: 'dev', status: 'running', activePtyProcessId: 801 })],
    runs: [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 801 })],
    ptyProcess: fakePtyProcessRow({ id: 801, backend: 'tmux', status: 'running' }),
    pty: { cleanupProcess: () => Effect.succeed('terminated' as const) },
  });

  assert.equal(Exit.isSuccess(result.exit), true);
  assert.deepEqual(result.recorder.cleaned, [
    { ptyProcessId: 801, reason: 'user_requested', ensureBackendAbsence: true },
  ]);
});
