import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause, Effect, Exit, Fiber } from 'effect';

import { DatabaseError } from '../../persistence/index.js';
import { RuntimeEventBus } from '../../runtime-events/index.js';
import { type CommandRunRow, type CommandStateRow } from '../commands.repository.js';
import {
  commandLaunchAllocation,
  commandRun,
  commandState,
  createFixture,
  fakePtyProcessRow,
  runCommandServiceEffect,
  writeConfig,
  type CommandRepositoryOptions,
} from './test-support.js';

/**
 * The ownership handoff: a command's run is linked to its PTY row *before* any
 * backend process exists, and every exit after the run is created either
 * completes that run or hands it to a defined recovery. These tests drive the
 * orderings that used to be unobservable — immediate exits, cancellation, and
 * persistence faults at each step — through repository hooks rather than clocks.
 *
 * The single-link invariant is asserted after each scenario: a command state's
 * pointer is null or equal to the latest retained run's PTY link, so at most one
 * nonterminal incarnation is ever linked in model.
 */

const config = `
commands:
  - name: dev
    command: pnpm dev
`;

interface StateTransition {
  readonly commandName: string;
  readonly status: string;
  readonly activePtyProcessId: number | null;
}

interface Harness {
  readonly runs: CommandRunRow[];
  // The durable state is observed through its transitions: the fake repository
  // owns the rows, and what these tests care about is exactly what was written.
  readonly transitions: StateTransition[];
  readonly published: Array<{ readonly commandName: string; readonly status: string }>;
  readonly calls: string[];
}

/**
 * Runs one command launch against the fake repository, capturing durable rows,
 * state transitions, published `command_changed` events, and the order of the
 * allocation machine's stages.
 */
async function launch(
  options: {
    readonly seedState?: CommandStateRow | undefined;
    readonly ptyProcessId?: number | undefined;
    readonly start?: Effect.Effect<never> | undefined;
    // Interrupts the launch once `predicate` reports the fiber has reached the
    // point under test. No timers: the launch itself is what advances.
    readonly interruptWhen?: ((harness: Harness) => boolean) | undefined;
  } & Pick<
    CommandRepositoryOptions,
    | 'ptyProcess'
    | 'ptyProcessReadFault'
    | 'pruneOutcome'
    | 'transitionFault'
    | 'updateRunPtyOutcome'
    | 'finalizeFault'
    | 'runs'
  > = {},
) {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, config);
  const runs: CommandRunRow[] = options.runs ?? [];
  const states: CommandStateRow[] = options.seedState ? [options.seedState] : [];
  const transitions: StateTransition[] = [];
  const published: Harness['published'] = [];
  const calls: string[] = [];
  const harness: Harness = { runs, transitions, published, calls };
  const ptyProcessId = options.ptyProcessId ?? 902;

  try {
    const outcome = await runCommandServiceEffect(
      fixture.rootPath,
      (service) =>
        Effect.gen(function* () {
          const bus = yield* RuntimeEventBus;
          const subscription = yield* bus.subscribe;
          const drain = yield* Effect.fork(
            Effect.forever(
              subscription.take.pipe(
                Effect.tap((event) =>
                  Effect.sync(() => {
                    if (event.type === 'command_changed') {
                      published.push({
                        commandName: event.payload.commandName,
                        status: event.payload.status,
                      });
                    }
                  }),
                ),
              ),
            ),
          );

          const launching = yield* Effect.fork(service.run({ worktreeId: 10, commandName: 'dev' }));
          if (options.interruptWhen) {
            yield* waitUntilEffect(() => options.interruptWhen!(harness));
            yield* Fiber.interrupt(launching);
          }
          const exit = yield* Fiber.await(launching);
          // Let the finalizer's publishes reach the subscriber queue.
          yield* settle();
          yield* Fiber.interrupt(drain);
          yield* subscription.unsubscribe;
          return exit;
        }),
      {
        states,
        runs,
        ...(options.ptyProcess === undefined ? {} : { ptyProcess: options.ptyProcess }),
        ...(options.ptyProcessReadFault
          ? { ptyProcessReadFault: options.ptyProcessReadFault }
          : {}),
        ...(options.pruneOutcome ? { pruneOutcome: options.pruneOutcome } : {}),
        ...(options.transitionFault ? { transitionFault: options.transitionFault } : {}),
        ...(options.updateRunPtyOutcome
          ? { updateRunPtyOutcome: options.updateRunPtyOutcome }
          : {}),
        ...(options.finalizeFault ? { finalizeFault: options.finalizeFault } : {}),
        onRunLinked: () => calls.push('link'),
        onTransition: (input) => transitions.push(input),
        pty: {
          allocateLaunch: () =>
            Effect.succeed(
              commandLaunchAllocation({
                ptyProcessId,
                cwd: fixture.rootPath,
                calls,
                ...(options.start ? { start: options.start } : {}),
              }),
            ),
        },
      },
    );
    assertSingleLink(harness);
    return { ...harness, exit: outcome, ptyProcessId };
  } finally {
    fixture.cleanup();
  }
}

function settle() {
  return Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
}

function waitUntilEffect(predicate: () => boolean) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
    }
    throw new Error('Timed out waiting for the launch to reach the point under test');
  });
}

/** The pointer is null, or it equals the latest retained run's PTY link. */
function assertSingleLink(harness: Harness) {
  const names = new Set(harness.transitions.map((transition) => transition.commandName));
  for (const name of names) {
    const last = harness.transitions.filter((transition) => transition.commandName === name).at(-1);
    if (!last || last.activePtyProcessId === null) continue;
    const latestRun = harness.runs.filter((run) => run.commandName === name).at(-1);
    assert.equal(
      last.activePtyProcessId,
      latestRun?.ptyProcessId,
      'state pointer must equal the latest run link',
    );
  }
}

function lastTransition(harness: Harness) {
  return harness.transitions.at(-1);
}

function launchFailure() {
  return new DatabaseError({ operation: 'create_pty_process_metadata', cause: new Error('nope') });
}

test('the run is linked to its PTY row before anything reaches a backend', async () => {
  const result = await launch();

  assert.deepEqual(result.calls, ['allocate', 'link', 'start']);
  assert.equal(result.runs.at(-1)?.ptyProcessId, result.ptyProcessId);
  assert.deepEqual(result.transitions, [
    // The launch-in-progress marker, then the completed handoff.
    { commandName: 'dev', status: 'running', activePtyProcessId: null },
    { commandName: 'dev', status: 'running', activePtyProcessId: 902 },
  ]);
  // The marker publishes nothing; only the completed handoff announces.
  assert.deepEqual(result.published, [{ commandName: 'dev', status: 'running' }]);
});

test('a post-start row still starting is owned and left for the poller to heal', async () => {
  const result = await launch({ ptyProcess: fakePtyProcessRow({ id: 902, status: 'starting' }) });

  assert.deepEqual(lastTransition(result), {
    commandName: 'dev',
    status: 'running',
    activePtyProcessId: 902,
  });
  assert.deepEqual(result.published.at(-1), { commandName: 'dev', status: 'running' });
});

test('a link-write failure converges the command without ever starting a process', async () => {
  const result = await launch({ updateRunPtyOutcome: () => launchFailure() });

  assert.ok(!result.calls.includes('start'), 'the backend must never be reached');
  assert.ok(result.calls.includes('abandon'), 'the allocation must be abandoned');
  assert.equal(result.runs.at(-1)?.status, 'failed');
  assert.equal(result.runs.at(-1)?.diagnosticReason, 'pty_launch_failed');
  assert.match(
    result.runs.at(-1)?.diagnosticDetail ?? '',
    /Could not record the process association; the command was not started/,
  );
  assert.equal(lastTransition(result)?.status, 'failed');
  assert.deepEqual(result.published.at(-1), { commandName: 'dev', status: 'failed' });
});

test('a link write reporting a vanished run is a defect, not a plausible failure', async () => {
  // The run was created moments ago under this command's lock. Reporting an
  // ordinary `failed` action would promise a diagnostic that has no row.
  const result = await launch({ updateRunPtyOutcome: () => 'missing' });

  assert.ok(Exit.isFailure(result.exit));
  assert.match(Cause.pretty(result.exit.cause), /vanished while linking PTY process 902/);
  assert.ok(!result.calls.includes('start'));
});

test('a step-8 finalize fault leaves run and state untouched as a unit', async () => {
  const result = await launch({
    ptyProcess: fakePtyProcessRow({ id: 902, status: 'exited', exitCode: 0 }),
    finalizeFault: (input) =>
      input.keying === 'run'
        ? new DatabaseError({ operation: 'finalize', cause: new Error('nope') })
        : null,
  });

  assert.equal(result.exit._tag, 'Failure');
  // No partial commit: the run is still open and the state still holds the
  // launch marker, so a later reconciliation can still land the true outcome.
  assert.equal(result.runs.at(-1)?.status, 'running');
  assert.deepEqual(lastTransition(result), {
    commandName: 'dev',
    status: 'running',
    activePtyProcessId: null,
  });
  assert.deepEqual(result.published, []);
});

test('an allocation failure converges the command and reports a readable diagnostic', async () => {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, config);
  const runs: CommandRunRow[] = [];
  try {
    const action = await runCommandServiceEffect(
      fixture.rootPath,
      (service) => service.run({ worktreeId: 10, commandName: 'dev' }),
      {
        runs,
        pty: { allocateLaunch: () => Effect.fail(launchFailure()) },
      },
    );
    assert.equal(action.summary.status, 'failed');
    assert.equal(runs.at(-1)?.status, 'failed');
    assert.equal(runs.at(-1)?.diagnosticReason, 'pty_launch_failed');
  } finally {
    fixture.cleanup();
  }
});

test('a pruning failure completes only the run and preserves the prior entity status', async () => {
  const result = await launch({
    seedState: { ...commandState({ commandName: 'dev', status: 'suspended' }) },
    runs: [commandRun({ commandName: 'dev', status: 'running' })],
    pruneOutcome: () =>
      Effect.fail(new DatabaseError({ operation: 'prune', cause: new Error('nope') })),
  });

  assert.equal(result.exit._tag, 'Failure');
  assert.equal(result.runs.at(-1)?.status, 'failed');
  assert.equal(result.runs.at(-1)?.diagnosticReason, 'pty_launch_failed');
  assert.match(result.runs.at(-1)?.diagnosticDetail ?? '', /Could not prepare the launch/);
  // A resume's intent survives for the next activation, and the unchanged status
  // is republished so the client refetches the metadata carrying the diagnostic.
  assert.deepEqual(result.transitions, [], 'the prior entity status is never rewritten');
  assert.deepEqual(result.published, [{ commandName: 'dev', status: 'suspended' }]);
});

test('a marker-write failure converges identically, publishing the unchanged status', async () => {
  const result = await launch({
    transitionFault: (input) =>
      input.status === 'running' && input.activePtyProcessId === null
        ? new DatabaseError({ operation: 'transition', cause: new Error('nope') })
        : null,
  });

  assert.equal(result.exit._tag, 'Failure');
  assert.equal(result.runs.at(-1)?.status, 'failed');
  assert.match(result.runs.at(-1)?.diagnosticDetail ?? '', /Could not record the launch/);
  // No state row exists yet, so the catalog projection's `idle` is published.
  assert.deepEqual(result.published, [{ commandName: 'dev', status: 'idle' }]);
  assert.ok(
    !result.calls.includes('allocate'),
    'no allocation may be taken after the marker fails',
  );
});

test('cancellation before the run is linked completes only the run', async () => {
  const result = await launch({
    seedState: { ...commandState({ commandName: 'dev', status: 'suspended' }) },
    runs: [commandRun({ commandName: 'dev', status: 'running' })],
    // Hang inside run-history pruning: after the run exists, before the marker
    // and before any allocation.
    pruneOutcome: () => Effect.never,
    interruptWhen: (harness) => harness.runs.length > 1,
  });

  assert.equal(result.exit._tag, 'Failure');
  assert.equal(result.runs.at(-1)?.status, 'failed');
  assert.equal(result.runs.at(-1)?.diagnosticReason, 'pty_launch_failed');
  assert.match(result.runs.at(-1)?.diagnosticDetail ?? '', /cancelled before the command process/);
  // The resume intent survives an interrupted launch.
  assert.deepEqual(result.transitions, [], 'the prior entity status is never rewritten');
});

test('cancellation after the spawn installs the pointer and announces it', async () => {
  const result = await launch({
    start: Effect.never,
    interruptWhen: (harness) => harness.calls.includes('start'),
  });

  assert.equal(result.exit._tag, 'Failure');
  // The caller is gone, so this publish is the only announcement the client
  // will get for a command that is durably running.
  assert.deepEqual(lastTransition(result), {
    commandName: 'dev',
    status: 'running',
    activePtyProcessId: 902,
  });
  assert.deepEqual(result.published.at(-1), { commandName: 'dev', status: 'running' });
  assert.equal(result.runs.at(-1)?.ptyProcessId, 902);
});

test('cancellation whose PTY row is unreadable still installs the pointer', async () => {
  const result = await launch({
    start: Effect.never,
    interruptWhen: (harness) => harness.calls.includes('start'),
    // The linked row cannot be read during recovery. Nothing is known about the
    // process, so it must be treated as owned rather than as dead.
    ptyProcessReadFault: () => new DatabaseError({ operation: 'find', cause: new Error('nope') }),
  });

  assert.equal(result.exit._tag, 'Failure');
  assert.deepEqual(lastTransition(result), {
    commandName: 'dev',
    status: 'running',
    activePtyProcessId: 902,
  });
  assert.deepEqual(result.published.at(-1), { commandName: 'dev', status: 'running' });
  assert.equal(result.runs.at(-1)?.status, 'running', 'an unreadable row may not end the run');
});

test('an unreadable PTY row after the spawn keeps ownership rather than failing the launch', async () => {
  const result = await launch({
    ptyProcessReadFault: () => new DatabaseError({ operation: 'find', cause: new Error('nope') }),
  });

  assert.equal(result.exit._tag, 'Success');
  assert.deepEqual(lastTransition(result), {
    commandName: 'dev',
    status: 'running',
    activePtyProcessId: 902,
  });
  assert.equal(result.runs.at(-1)?.status, 'running');
});
