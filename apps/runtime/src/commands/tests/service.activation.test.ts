import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Fiber } from 'effect';

import {
  defaultCommandLifecycle,
  type WorktreeCommandConfig,
} from '../../project-config/project-config.schema.js';
import { buildActivationPlan } from '../commands.lifecycle.js';
import type { CommandStateRow } from '../commands.repository.js';
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
 * What a worktree switch does to that worktree's commands.
 *
 * Leaving suspends what the user configured Isagi to stop, plus anything still
 * running that the config no longer names — but never a documented keep-alive
 * command, and never anything at all when the config cannot be read. Arriving
 * resumes exactly the commands the previous switch suspended, and first-starts
 * opt-ins that have never run. Every entry re-checks both the durable state and
 * the config inside the command's lock, so newer intent always beats the plan.
 */

const configuredCommands = `
commands:
  - name: dev
    command: pnpm dev
  - name: db
    command: docker compose up
    lifecycle:
      deactivate:
        stop: false
`;

const automationCommand = `
commands:
  - name: auto
    command: pnpm auto
    lifecycle:
      activate:
        start: true
`;

async function switchWorktrees(
  input: {
    readonly config: string;
    readonly previousWorktreeId?: number | null | undefined;
    readonly nextWorktreeId?: number | null | undefined;
    readonly cause?: 'active_context_changed' | 'startup_restored' | undefined;
    readonly states?: CommandStateRow[] | undefined;
  } & Pick<CommandRepositoryOptions, 'runs' | 'pty' | 'ptyProcess' | 'afterListStates'>,
) {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, input.config);
  const previousWorktreeId =
    input.previousWorktreeId === undefined ? null : input.previousWorktreeId;
  const nextWorktreeId = input.nextWorktreeId === undefined ? 10 : input.nextWorktreeId;
  try {
    return await runCommandScenario(
      fixture.rootPath,
      ({ internalEvents, recorder: progress }) =>
        Effect.gen(function* () {
          yield* internalEvents.publish({
            type: 'worktree_activation_change',
            previousWorktreeId,
            nextWorktreeId,
            cause: input.cause ?? 'active_context_changed',
          });
          yield* waitForLog(
            progress,
            nextWorktreeId === null
              ? '[runtime] Deactivation suspended'
              : '[runtime] Activation completed',
          );
        }),
      {
        states: input.states ?? [],
        runs: input.runs ?? [],
        ptyProcess: input.ptyProcess ?? fakePtyProcessRow(),
        ...(input.pty ? { pty: input.pty } : {}),
        ...(input.afterListStates ? { afterListStates: input.afterListStates } : {}),
      },
    );
  } finally {
    fixture.cleanup();
  }
}

function running(commandName: string, ptyProcessId: number): CommandStateRow {
  return { ...commandState({ commandName, status: 'running' }), activePtyProcessId: ptyProcessId };
}

function suspendedNames(recorder: CommandScenarioRecorder) {
  return recorder.transitions
    .filter((entry) => entry.status === 'suspended')
    .map((entry) => entry.commandName);
}

test('leaving a worktree suspends configured defaults and leaves keep-alive commands running', async () => {
  const { recorder } = await switchWorktrees({
    config: configuredCommands,
    previousWorktreeId: 10,
    nextWorktreeId: null,
    states: [running('dev', 123), running('db', 456)],
    runs: [
      { ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }), id: 1 },
      { ...commandRun({ commandName: 'db', status: 'running', ptyProcessId: 456 }), id: 2 },
    ],
  });

  // `deactivate.stop: false` is never even a candidate.
  assert.deepEqual(recorder.terminated, [123]);
  assert.deepEqual(suspendedNames(recorder), ['dev']);
  assert.deepEqual(recorder.published, [{ commandName: 'dev', status: 'suspended' }]);
});

test('the sweep suspends a running command the config no longer names', async () => {
  const { recorder } = await switchWorktrees({
    config: configuredCommands,
    previousWorktreeId: 10,
    nextWorktreeId: null,
    states: [running('old dev', 321)],
    runs: [
      { ...commandRun({ commandName: 'old dev', status: 'running', ptyProcessId: 321 }), id: 1 },
    ],
  });

  assert.deepEqual(recorder.terminated, [321]);
  assert.deepEqual(suspendedNames(recorder), ['old dev']);
  assert.ok(
    recorder.logs.some((line) =>
      line.includes('Deactivation suspended 1 command(s), considered 1 unconfigured'),
    ),
  );
});

test('an unreadable config skips the whole deactivation pass rather than risk a keep-alive command', async () => {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, 'commands:\n  - name: dev\n    command: [oops\n');
  try {
    const { recorder } = await runCommandScenario(
      fixture.rootPath,
      ({ internalEvents, recorder: progress }) =>
        Effect.gen(function* () {
          yield* internalEvents.publish({
            type: 'worktree_activation_change',
            previousWorktreeId: 10,
            nextWorktreeId: null,
            cause: 'active_context_changed',
          });
          yield* waitForLog(progress, 'Command deactivate lifecycle skipped');
        }),
      {
        states: [running('dev', 123)],
        runs: [
          { ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }), id: 1 },
        ],
      },
    );

    assert.deepEqual(recorder.terminated, []);
    assert.deepEqual(recorder.transitions, []);
  } finally {
    fixture.cleanup();
  }
});

test('a user-driven return resumes only suspended commands', async () => {
  const { recorder } = await switchWorktrees({
    config: configuredCommands,
    states: [
      commandState({ commandName: 'dev', status: 'suspended' }),
      commandState({ commandName: 'db', status: 'exited' }),
    ],
  });

  assert.deepEqual(recorder.launched, ['pnpm dev']);
  assert.ok(
    recorder.logs.some((line) => line.includes('Activation launch command=dev reason=resume')),
  );
});

test('a runtime restart never resumes a suspended command', async () => {
  const { recorder } = await switchWorktrees({
    config: configuredCommands,
    cause: 'startup_restored',
    states: [commandState({ commandName: 'dev', status: 'suspended' })],
  });

  assert.deepEqual(recorder.launched, []);
  assert.deepEqual(recorder.transitions, []);
  assert.ok(
    recorder.logs.some((line) => line.includes('Activation completed: executed 0 resume(s)')),
  );
});

test('activation first-starts an opt-in command that has never run', async () => {
  const { recorder } = await switchWorktrees({ config: automationCommand });

  assert.deepEqual(recorder.launched, ['pnpm auto']);
  assert.ok(
    recorder.logs.some((line) => line.includes('Activation launch command=auto reason=automation')),
  );
});

test('activation first-starts an idle opt-in command', async () => {
  const { recorder } = await switchWorktrees({
    config: automationCommand,
    states: [commandState({ commandName: 'auto', status: 'idle' })],
  });

  assert.deepEqual(recorder.launched, ['pnpm auto']);
});

for (const status of ['exited', 'failed', 'stopped'] as const) {
  test(`activation does not restart an opt-in command that already ${status}`, async () => {
    const { recorder } = await switchWorktrees({
      config: automationCommand,
      states: [commandState({ commandName: 'auto', status })],
    });

    assert.deepEqual(recorder.launched, []);
    assert.ok(
      recorder.logs.some((line) =>
        line.includes('Activation completed: executed 0 resume(s) and 0'),
      ),
    );
  });
}

test('an explicit stop between the snapshot and the launch discards the resume', async () => {
  const { recorder } = await switchWorktrees({
    config: configuredCommands,
    states: [commandState({ commandName: 'dev', status: 'suspended' })],
    // The user pressed Stop while the pass was still working through its plan.
    afterListStates: (states) => {
      const state = states.find((candidate) => candidate.commandName === 'dev');
      if (state) states.splice(states.indexOf(state), 1, { ...state, status: 'stopped' });
    },
  });

  assert.deepEqual(recorder.launched, []);
  assert.ok(
    recorder.logs.some((line) =>
      line.includes('Activation discarded command=dev reason=resume because=state_changed'),
    ),
  );
});

test('an activate.start flipped off after planning discards the automation entry', async () => {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, automationCommand);
  try {
    const { recorder } = await runCommandScenario(
      fixture.rootPath,
      ({ internalEvents, recorder: progress }) =>
        Effect.gen(function* () {
          yield* internalEvents.publish({
            type: 'worktree_activation_change',
            previousWorktreeId: null,
            nextWorktreeId: 10,
            cause: 'active_context_changed',
          });
          yield* waitForLog(progress, '[runtime] Activation completed');
        }),
      {
        states: [],
        afterListStates: () => {
          writeConfig(
            fixture.rootPath,
            `
commands:
  - name: auto
    command: pnpm auto
`,
          );
        },
      },
    );

    assert.deepEqual(recorder.launched, []);
    assert.ok(
      recorder.logs.some((line) =>
        line.includes('Activation discarded command=auto reason=automation because=config_changed'),
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a command removed from config after planning discards its resume', async () => {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, configuredCommands);
  try {
    const { recorder } = await runCommandScenario(
      fixture.rootPath,
      ({ internalEvents, recorder: progress }) =>
        Effect.gen(function* () {
          yield* internalEvents.publish({
            type: 'worktree_activation_change',
            previousWorktreeId: null,
            nextWorktreeId: 10,
            cause: 'active_context_changed',
          });
          yield* waitForLog(progress, '[runtime] Activation completed');
        }),
      {
        states: [commandState({ commandName: 'dev', status: 'suspended' })],
        afterListStates: () => {
          writeConfig(fixture.rootPath, 'commands: []\n');
        },
      },
    );

    assert.deepEqual(recorder.launched, []);
    assert.ok(
      recorder.logs.some((line) =>
        line.includes('Activation discarded command=dev reason=resume because=config_removed'),
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a suspended command missing from the config stays suspended and resumes when it returns', async () => {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, 'commands: []\n');
  try {
    const { recorder } = await runCommandScenario(
      fixture.rootPath,
      ({ internalEvents, recorder: progress }) =>
        Effect.gen(function* () {
          yield* internalEvents.publish({
            type: 'worktree_activation_change',
            previousWorktreeId: null,
            nextWorktreeId: 10,
            cause: 'active_context_changed',
          });
          yield* waitForLog(progress, 'Activation completed: executed 0 resume(s)');
          // The command comes back to the config; the intent was still there.
          writeConfig(fixture.rootPath, configuredCommands);
          yield* internalEvents.publish({
            type: 'worktree_activation_change',
            previousWorktreeId: null,
            nextWorktreeId: 10,
            cause: 'active_context_changed',
          });
          yield* waitForLog(progress, 'Activation completed: executed 1 resume(s)');
        }),
      {
        states: [commandState({ commandName: 'dev', status: 'suspended' })],
        ptyProcess: fakePtyProcessRow(),
      },
    );

    assert.deepEqual(recorder.launched, ['pnpm dev']);
  } finally {
    fixture.cleanup();
  }
});

test('an activation event for a deleted worktree is logged without failing the pass', async () => {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, configuredCommands);
  try {
    const { recorder } = await runCommandScenario(
      fixture.rootPath,
      ({ internalEvents, recorder: progress }) =>
        Effect.gen(function* () {
          yield* internalEvents.publish({
            type: 'worktree_activation_change',
            previousWorktreeId: 99,
            nextWorktreeId: 10,
            cause: 'active_context_changed',
          });
          // The pass survives the missing worktree and still activates the next.
          yield* waitForLog(progress, '[runtime] Activation completed');
        }),
      { states: [] },
    );

    assert.ok(recorder.logs.some((line) => line.includes('Command lifecycle deactivate failed')));
  } finally {
    fixture.cleanup();
  }
});

test('a command with a state row is swept even when its launch is still in flight', async () => {
  const fixture = createFixture();
  writeConfig(
    fixture.rootPath,
    `
commands:
  - name: sweeper
    command: pnpm sweeper
`,
  );
  // The launch is held open at its prune step until the deactivation pass has
  // taken its snapshot — a hook, not a timer, so the ordering under test is the
  // one that actually runs.
  let releaseLaunch: (() => void) | null = null;
  try {
    const { recorder } = await runCommandScenario(
      fixture.rootPath,
      ({ service, internalEvents, recorder: progress }) =>
        Effect.gen(function* () {
          const launching = yield* Effect.fork(
            service.run({ worktreeId: 10, commandName: 'sweeper' }),
          );
          yield* waitForLog(progress, 'launch-gate-entered');
          // The command leaves the config while its launch is in flight.
          writeConfig(fixture.rootPath, 'commands: []\n');
          yield* internalEvents.publish({
            type: 'worktree_activation_change',
            previousWorktreeId: 10,
            nextWorktreeId: null,
            cause: 'active_context_changed',
          });
          yield* Fiber.await(launching);
          yield* waitForLog(progress, '[runtime] Deactivation suspended');
        }),
      {
        // A prior outcome, so the command has a state row before the pass runs.
        states: [commandState({ commandName: 'sweeper', status: 'stopped' })],
        ptyProcess: fakePtyProcessRow({ id: 902, status: 'running' }),
        // The pass has snapshotted; let the launch complete and take its lock
        // back, so the sweep's own read happens after the marker is durable.
        afterListStates: () => releaseLaunch?.(),
        pruneOutcome: () => {
          console.info('launch-gate-entered');
          return Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                releaseLaunch = resolve;
              }),
          );
        },
      },
    );

    // The snapshot enumerated it from its state row, the lock serialized the two,
    // and the fresh read inside the lock saw the launch's `running`.
    assert.deepEqual(suspendedNames(recorder), ['sweeper']);
  } finally {
    fixture.cleanup();
  }
});

test('a command with no state row at the snapshot survives the pass it raced', async () => {
  const fixture = createFixture();
  writeConfig(
    fixture.rootPath,
    `
commands:
  - name: sweeper
    command: pnpm sweeper
`,
  );
  let releaseLaunch: (() => void) | null = null;
  try {
    const { recorder } = await runCommandScenario(
      fixture.rootPath,
      ({ service, internalEvents, recorder: progress }) =>
        Effect.gen(function* () {
          const launching = yield* Effect.fork(
            service.run({ worktreeId: 10, commandName: 'sweeper' }),
          );
          yield* waitForLog(progress, 'launch-gate-entered');
          writeConfig(fixture.rootPath, 'commands: []\n');
          yield* internalEvents.publish({
            type: 'worktree_activation_change',
            previousWorktreeId: 10,
            nextWorktreeId: null,
            cause: 'active_context_changed',
          });
          yield* waitForLog(progress, '[runtime] Deactivation suspended');
          releaseLaunch?.();
          yield* Fiber.await(launching);
        }),
      {
        // No command-state footprint at snapshot time: the durable `running`
        // marker is the launch's linearization point, and this launch reaches it
        // afterwards. Documented policy — the command survives this pass, and
        // the next switch (which will find its state row) suspends it.
        states: [],
        ptyProcess: fakePtyProcessRow({ id: 902, status: 'running' }),
        pruneOutcome: () => {
          console.info('launch-gate-entered');
          return Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                releaseLaunch = resolve;
              }),
          );
        },
      },
    );

    assert.deepEqual(suspendedNames(recorder), []);
    assert.ok(recorder.logs.some((line) => line.includes('Deactivation suspended 0 command(s)')));
    assert.deepEqual(recorder.published.at(-1), { commandName: 'sweeper', status: 'running' });
  } finally {
    fixture.cleanup();
  }
});

// The plan is a pure decision over one snapshot, so it can be read and checked
// directly — no service, no repository, no config file.

function configuredCommand(input: {
  readonly name: string;
  readonly activateStart?: boolean | undefined;
}): WorktreeCommandConfig {
  return {
    name: input.name,
    command: `pnpm ${input.name}`,
    cwd: null,
    env: {},
    envFiles: [],
    ports: [],
    lifecycle: {
      ...defaultCommandLifecycle,
      activate: { start: input.activateStart ?? false },
    },
  };
}

test('the activation plan resumes suspended commands only on a user-driven return', () => {
  const commands = [configuredCommand({ name: 'dev' })];
  const states = [commandState({ commandName: 'dev', status: 'suspended' })];

  assert.deepEqual(buildActivationPlan({ commands, states, cause: 'active_context_changed' }), [
    { commandName: 'dev', reason: 'resume' },
  ]);
  assert.deepEqual(buildActivationPlan({ commands, states, cause: 'startup_restored' }), []);
});

test('the activation plan first-starts an opt-in only with no prior outcome', () => {
  const commands = [configuredCommand({ name: 'auto', activateStart: true })];
  const plan = (status: CommandStateRow['status'] | 'absent') =>
    buildActivationPlan({
      commands,
      states: status === 'absent' ? [] : [commandState({ commandName: 'auto', status })],
      cause: 'active_context_changed',
    });

  assert.deepEqual(plan('absent'), [{ commandName: 'auto', reason: 'automation' }]);
  assert.deepEqual(plan('idle'), [{ commandName: 'auto', reason: 'automation' }]);
  for (const status of ['exited', 'failed', 'stopped', 'running'] as const) {
    assert.deepEqual(plan(status), [], `${status} must not be first-started`);
  }
  // A suspended opt-in is a resume, never a second first-start: the two sets are
  // disjoint by construction, so no precedence rule is needed.
  assert.deepEqual(plan('suspended'), [{ commandName: 'auto', reason: 'resume' }]);
});

test('the activation plan ignores a suspended command the config no longer names', () => {
  assert.deepEqual(
    buildActivationPlan({
      commands: [],
      states: [commandState({ commandName: 'dev', status: 'suspended' })],
      cause: 'active_context_changed',
    }),
    [],
  );
});
