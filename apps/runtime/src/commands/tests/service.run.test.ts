import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { DatabaseError } from '../../persistence/index.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { type CommandRunRow } from '../commands.repository.js';
import { CommandService } from '../commands.service.js';
import {
  commandLaunchAllocation,
  commandPortProbe,
  commandRun,
  commandState,
  createFixture,
  fakePtyProcessRow,
  runCommandServiceEffect,
  writeConfig,
} from './test-support.js';

test('command service stops a running removed managed command', async () => {
  const fixture = createFixture();
  const terminated: number[] = [];
  const transitioned: Array<{
    readonly commandName: string;
    readonly status: string;
    readonly activePtyProcessId: number | null;
  }> = [];
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
`,
    );

    const output = await runCommandServiceEffect(
      fixture.rootPath,
      (service) => service.stop({ worktreeId: 10, commandName: 'old dev' }),
      {
        states: [commandState({ commandName: 'old dev', status: 'running' })],
        latestRun: commandRun({ commandName: 'old dev', status: 'running', ptyProcessId: 123 }),
        pty: {
          terminate: (input) =>
            Effect.sync(() => {
              terminated.push(input.ptyProcessId);
              return 'terminated_live' as const;
            }),
        },
        onTransition: (input) => transitioned.push(input),
      },
    );

    assert.deepEqual(terminated, [123]);
    assert.deepEqual(output, {
      worktreeId: 10,
      commandName: 'old dev',
      summary: { name: 'old dev', status: 'stopped', ports: [] },
    });
    assert.ok(
      transitioned.some(
        (transition) => transition.commandName === 'old dev' && transition.status === 'stopped',
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('command service keeps launch-failure diagnostics readable in latest metadata', async () => {
  const fixture = createFixture();
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
`,
    );

    const output = await runCommandServiceEffect(
      fixture.rootPath,
      (service) =>
        Effect.gen(function* () {
          const action = yield* service.run({ worktreeId: 10, commandName: 'dev' });
          const metadata = yield* service.readLogMetadata({
            worktreeId: 10,
            commandName: 'dev',
          });
          return { action, metadata };
        }),
      {
        pty: {
          // Allocation is a launch's only expected-failure stage now that
          // `start` is total, so the command's launch-failure branch is
          // reached through the durable allocation write.
          allocateLaunch: () =>
            Effect.fail(
              new DatabaseError({
                operation: 'create_pty_process_metadata',
                cause: new Error('launch failed'),
              }),
            ),
        },
      },
    );

    assert.equal(output.action.summary.status, 'failed');
    assert.equal(output.metadata.status, 'failed');
    assert.equal(output.metadata.latestRun?.diagnostic?.reason, 'pty_launch_failed');
    assert.equal(
      output.metadata.latestRun?.diagnostic?.detail,
      'Database operation create_pty_process_metadata failed: Error',
    );
  } finally {
    fixture.cleanup();
  }
});

test('command service maps non-zero process exits to failed command state', async () => {
  const fixture = createFixture();
  const transitioned: Array<{
    readonly commandName: string;
    readonly status: string;
    readonly activePtyProcessId: number | null;
  }> = [];
  const runs = [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 })];
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
`,
    );

    await runCommandServiceEffect(
      fixture.rootPath,
      () =>
        Effect.gen(function* () {
          yield* CommandService;
          const bus = yield* InternalRuntimeEventBus;
          yield* bus.publish({
            type: 'pty_process_exited',
            ptyProcessId: 123,
            status: 'exited',
            exitCode: 1,
            signal: null,
          });
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
        }),
      {
        states: [commandState({ commandName: 'dev', status: 'running' })],
        runs,
        onTransition: (input) => transitioned.push(input),
      },
    );

    assert.equal(runs[0]?.status, 'failed');
    assert.ok(
      transitioned.some(
        (transition) => transition.commandName === 'dev' && transition.status === 'failed',
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a shutdown kill is recorded as an interruption, not a plain failure', async () => {
  const fixture = createFixture();
  const runs = [commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 })];
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
`,
    );

    await runCommandServiceEffect(
      fixture.rootPath,
      () =>
        Effect.gen(function* () {
          yield* CommandService;
          const bus = yield* InternalRuntimeEventBus;
          yield* bus.publish({
            type: 'pty_process_killed',
            ptyProcessId: 123,
            status: 'killed',
            statusReason: 'runtime_shutdown',
          });
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
        }),
      {
        states: [commandState({ commandName: 'dev', status: 'running' })],
        runs,
      },
    );

    assert.equal(runs[0]?.status, 'failed');
    // The same bytes boot reconciliation writes, so both teardown orderings are
    // indistinguishable to the user.
    assert.equal(runs[0]?.diagnosticReason, 'runtime_stopped');
    assert.equal(
      runs[0]?.diagnosticDetail,
      'Runtime stopped while this command was running. Not restarted.',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a late echo from a superseded incarnation changes and announces nothing', async () => {
  const fixture = createFixture();
  const transitioned: Array<{
    readonly commandName: string;
    readonly status: string;
    readonly activePtyProcessId: number | null;
  }> = [];
  // The old incarnation's run is already terminal, and the command has since
  // been relaunched onto a new one.
  const runs = [
    commandRun({ commandName: 'dev', status: 'stopped', ptyProcessId: 123 }),
    { ...commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 777 }), id: 2 },
  ];
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
`,
    );

    await runCommandServiceEffect(
      fixture.rootPath,
      () =>
        Effect.gen(function* () {
          yield* CommandService;
          const bus = yield* InternalRuntimeEventBus;
          yield* bus.publish({
            type: 'pty_process_exited',
            ptyProcessId: 123,
            status: 'exited',
            exitCode: 0,
            signal: null,
          });
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
        }),
      {
        states: [
          {
            ...commandState({ commandName: 'dev', status: 'running' }),
            activePtyProcessId: 777,
          },
        ],
        runs,
        onTransition: (input) => transitioned.push(input),
      },
    );

    // The terminal run keeps its first recorded outcome, the newer incarnation
    // keeps the pointer, and no stale status is announced over the running one.
    assert.equal(runs[0]?.status, 'stopped');
    assert.equal(runs[1]?.status, 'running');
    assert.deepEqual(transitioned, []);
  } finally {
    fixture.cleanup();
  }
});

test('command service records a successful run and retains its log after the process exits', async () => {
  const fixture = createFixture();
  const transitioned: Array<{
    readonly commandName: string;
    readonly status: string;
    readonly activePtyProcessId: number | null;
  }> = [];
  const runs: CommandRunRow[] = [];
  const ptyLogPath = join(fixture.rootPath, 'sessions', 'cmd-901.ptylog');
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
`,
    );
    mkdirSync(join(fixture.rootPath, 'sessions'), { recursive: true });
    writeFileSync(ptyLogPath, 'dev server ready on 5173\n');

    const output = await runCommandServiceEffect(
      fixture.rootPath,
      (service) =>
        Effect.gen(function* () {
          const action = yield* service.run({ worktreeId: 10, commandName: 'dev' });
          const bus = yield* InternalRuntimeEventBus;
          yield* bus.publish({
            type: 'pty_process_exited',
            ptyProcessId: 901,
            status: 'exited',
            exitCode: 0,
            signal: null,
          });
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
          const metadata = yield* service.readLogMetadata({
            worktreeId: 10,
            commandName: 'dev',
          });
          return { action, metadata };
        }),
      {
        runs,
        pty: {
          allocateLaunch: () =>
            Effect.succeed(
              commandLaunchAllocation({
                ptyProcessId: 901,
                cwd: fixture.rootPath,
                logPath: ptyLogPath,
              }),
            ),
        },
        onTransition: (input) => transitioned.push(input),
      },
    );

    assert.equal(output.action.summary.status, 'running');
    assert.equal(runs.at(-1)?.status, 'exited');
    assert.equal(output.metadata.status, 'exited');
    assert.equal(output.metadata.latestRun?.ptyProcessId, 901);
    assert.equal(output.metadata.latestRun?.hasPtyProcess, true);
    assert.equal(output.metadata.latestRun?.diagnostic, null);
    assert.ok(
      transitioned.some(
        (transition) => transition.commandName === 'dev' && transition.status === 'exited',
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('command service prunes superseded runs without touching PTY log retention', async () => {
  const fixture = createFixture();
  const runs: CommandRunRow[] = [
    commandRun({ commandName: 'dev', status: 'exited', ptyProcessId: 900 }),
  ];
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
    cwd: missing-dir
`,
    );

    await runCommandServiceEffect(
      fixture.rootPath,
      (service) => service.run({ worktreeId: 10, commandName: 'dev' }),
      { runs },
    );

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'failed');
    assert.equal(runs[0]?.diagnosticReason, 'missing_cwd');
    assert.equal(runs[0]?.ptyProcessId, null);
  } finally {
    fixture.cleanup();
  }
});

// The launch handshake. A process that dies before its run is linked publishes
// its terminal event to nobody — `findRunByPtyProcess` cannot resolve an owner
// yet — and a PTY row's first terminal fact is now final, so nothing later
// resurrects the row into the poller's view. Reading the row after linking is
// what keeps an immediate exit observable to the command.

async function runWithImmediateOutcome(
  fixture: ReturnType<typeof createFixture>,
  process: Partial<ReturnType<typeof fakePtyProcessRow>>,
) {
  const runs: CommandRunRow[] = [];
  const transitioned: Array<{
    readonly commandName: string;
    readonly status: string;
    readonly activePtyProcessId: number | null;
  }> = [];
  writeConfig(
    fixture.rootPath,
    `
commands:
  - name: dev
    command: pnpm dev
`,
  );
  const output = await runCommandServiceEffect(
    fixture.rootPath,
    (service) => service.run({ worktreeId: 10, commandName: 'dev' }),
    {
      runs,
      ptyProcess: fakePtyProcessRow({ id: 902, ...process }),
      pty: {
        allocateLaunch: () =>
          Effect.succeed(commandLaunchAllocation({ ptyProcessId: 902, cwd: fixture.rootPath })),
      },
      onTransition: (input) => transitioned.push(input),
    },
  );
  return { output, runs, transitioned };
}

test('a command whose process exits before its run is linked is not left recorded running', async () => {
  const fixture = createFixture();
  try {
    const { output, runs, transitioned } = await runWithImmediateOutcome(fixture, {
      status: 'exited',
      exitCode: 0,
    });

    assert.equal(output.summary.status, 'exited');
    assert.equal(runs.at(-1)?.status, 'exited');
    // A clean exit is not a launch failure, so it carries no launch diagnostic.
    assert.equal(runs.at(-1)?.diagnosticReason, null);
    assert.deepEqual(transitioned.at(-1), {
      commandName: 'dev',
      status: 'exited',
      activePtyProcessId: null,
    });
  } finally {
    fixture.cleanup();
  }
});

test('a non-zero immediate exit is recorded as a failed run without a launch diagnostic', async () => {
  const fixture = createFixture();
  try {
    const { output, runs } = await runWithImmediateOutcome(fixture, {
      status: 'exited',
      exitCode: 127,
    });

    assert.equal(output.summary.status, 'failed');
    assert.equal(runs.at(-1)?.status, 'failed');
    assert.equal(runs.at(-1)?.diagnosticReason, null);
  } finally {
    fixture.cleanup();
  }
});

test('any failed row observed during the handoff is a failed launch from the caller perspective', async () => {
  const fixture = createFixture();
  try {
    // `backend_process_missing` classified the row, not `backend_launch_failed` —
    // but the command still never got a usable process out of this launch.
    const { output, runs } = await runWithImmediateOutcome(fixture, {
      status: 'failed',
      statusReason: 'backend_process_missing',
    });

    assert.equal(output.summary.status, 'failed');
    assert.equal(runs.at(-1)?.diagnosticReason, 'pty_launch_failed');
    assert.equal(runs.at(-1)?.diagnosticDetail, 'backend_process_missing');
  } finally {
    fixture.cleanup();
  }
});

test('a killed row observed during the handoff maps through the shared run-status rule', async () => {
  const fixture = createFixture();
  try {
    const { output, runs } = await runWithImmediateOutcome(fixture, {
      status: 'killed',
      statusReason: 'user_requested',
    });

    assert.equal(output.summary.status, 'stopped');
    assert.equal(runs.at(-1)?.status, 'stopped');
    assert.equal(runs.at(-1)?.diagnosticReason, null);
  } finally {
    fixture.cleanup();
  }
});

test('stopping a command whose process was already gone claims no stop it did not perform', async () => {
  const fixture = createFixture();
  const transitioned: Array<{
    readonly commandName: string;
    readonly status: string;
    readonly activePtyProcessId: number | null;
  }> = [];
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
`,
    );

    const output = await runCommandServiceEffect(
      fixture.rootPath,
      (service) => service.stop({ worktreeId: 10, commandName: 'dev' }),
      {
        states: [commandState({ commandName: 'dev', status: 'running' })],
        latestRun: commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }),
        pty: { terminate: () => Effect.succeed('already_absent' as const) },
        onTransition: (input) => transitioned.push(input),
      },
    );

    // The command stays truthfully `running` until the incarnation's real
    // terminal fact reconciles it. Writing `stopped` here would assert that a
    // person stopped a process this call never touched.
    assert.equal(output.summary.status, 'running');
    assert.deepEqual(transitioned, []);
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Allocation memory across incarnations
// ---------------------------------------------------------------------------

/**
 * Allocation stability, proven through public service operations rather than by
 * calling the resolver: what matters to a user is that Restart and a resumed
 * command come back on the addresses they had, and that is a property of the
 * whole lifecycle, not of the policy function.
 */

const memoryConfig = `
commands:
  - name: dev
    command: pnpm dev
    ports:
      - envVar: API_PORT
        paths:
          - label: app
            path: /
`;

const previousResolution = [
  { envVar: 'API_PORT', port: 51824, paths: [{ label: 'app', path: '/' }] },
] as const;

test('restart re-adopts the same port when the probe finds it free', async () => {
  const fixture = createFixture();
  try {
    writeConfig(fixture.rootPath, memoryConfig);
    const probe = commandPortProbe({ inactive: [51_824] });

    const output = await runCommandServiceEffect(
      fixture.rootPath,
      (service) => service.restart({ worktreeId: 10, commandName: 'dev' }),
      {
        states: [
          commandState({
            commandName: 'dev',
            status: 'running',
            resolvedPorts: previousResolution,
          }),
        ],
        latestRun: commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }),
        ptyProcess: fakePtyProcessRow({ id: 902, status: 'running' }),
        pty: {
          terminate: () => Effect.succeed('terminated_live' as const),
          allocateLaunch: () =>
            Effect.succeed(commandLaunchAllocation({ ptyProcessId: 902, cwd: fixture.rootPath })),
        },
        portProbe: probe.service,
      },
    );

    // The stop preserved the snapshot by omission, so the relaunch inside the
    // same lock still had the preference to prefer.
    assert.deepEqual(probe.calls.probed, [51_824]);
    assert.equal(probe.calls.assignments(), 0);
    assert.deepEqual(output.summary.ports, [
      {
        port: 51_824,
        envVar: 'API_PORT',
        urls: [{ label: 'app', path: '/', url: 'http://localhost:51824/' }],
      },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('restart moves to a fresh port when the previous one is taken', async () => {
  const fixture = createFixture();
  try {
    writeConfig(fixture.rootPath, memoryConfig);
    const probe = commandPortProbe({ assign: [40_777] });

    const output = await runCommandServiceEffect(
      fixture.rootPath,
      (service) => service.restart({ worktreeId: 10, commandName: 'dev' }),
      {
        states: [
          commandState({
            commandName: 'dev',
            status: 'running',
            resolvedPorts: previousResolution,
          }),
        ],
        latestRun: commandRun({ commandName: 'dev', status: 'running', ptyProcessId: 123 }),
        ptyProcess: fakePtyProcessRow({ id: 902, status: 'running' }),
        pty: {
          terminate: () => Effect.succeed('terminated_live' as const),
          allocateLaunch: () =>
            Effect.succeed(commandLaunchAllocation({ ptyProcessId: 902, cwd: fixture.rootPath })),
        },
        portProbe: probe.service,
      },
    );

    // Preference, not guarantee: something else holds 51824 now, so the command
    // gets a working address rather than a familiar broken one.
    assert.deepEqual(probe.calls.probed, [51_824]);
    assert.equal(probe.calls.assignments(), 1);
    assert.deepEqual(
      output.summary.ports?.map((port) => port.port),
      [40_777],
    );
  } finally {
    fixture.cleanup();
  }
});

test('a command removed from config and re-added under the same name keeps its memory', async () => {
  const fixture = createFixture();
  try {
    // Genuinely remove it: the config names another command entirely, which is
    // the state of the world after a user comments the entry out.
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: other
    command: pnpm other
`,
    );
    const probe = commandPortProbe({ inactive: [51_824] });

    const output = await runCommandServiceEffect(
      fixture.rootPath,
      (service) =>
        Effect.gen(function* () {
          // While removed, the command is still visible as a managed row and
          // nothing prunes it. This half is what the reuse below depends on: if
          // a future config reconciliation started deleting state rows for
          // unnamed commands, the memory would be gone before the re-add.
          const removed = yield* service.listForWorktree(10);
          assert.deepEqual(
            removed.status === 'configured'
              ? removed.removedCommands.map((command) => command.name)
              : null,
            ['dev'],
          );

          // Re-added under the same name, which is the same allocation identity:
          // (worktree, command name, envVar).
          writeConfig(fixture.rootPath, memoryConfig);
          return yield* service.run({ worktreeId: 10, commandName: 'dev' });
        }),
      {
        states: [
          commandState({ commandName: 'dev', status: 'failed', resolvedPorts: previousResolution }),
        ],
        ptyProcess: fakePtyProcessRow({ id: 902, status: 'running' }),
        pty: {
          allocateLaunch: () =>
            Effect.succeed(commandLaunchAllocation({ ptyProcessId: 902, cwd: fixture.rootPath })),
        },
        portProbe: probe.service,
      },
    );

    assert.equal(probe.calls.assignments(), 0);
    assert.deepEqual(
      output.summary.ports?.map((port) => port.port),
      [51_824],
    );
  } finally {
    fixture.cleanup();
  }
});

test('resolving a pointerless running state preserves the ports it had', async () => {
  const fixture = createFixture();
  const transitions: Array<{
    readonly status: string;
    readonly resolvedPorts?: readonly unknown[] | undefined;
  }> = [];
  try {
    writeConfig(fixture.rootPath, memoryConfig);

    // A `running` state naming no incarnation and owning no run — the residue a
    // crash between the launch marker and the PTY link leaves behind. Stop can
    // only conclude `failed`, which is a manufactured status.
    await runCommandServiceEffect(
      fixture.rootPath,
      (service) => service.stop({ worktreeId: 10, commandName: 'dev' }),
      {
        states: [
          {
            ...commandState({
              commandName: 'dev',
              status: 'running',
              resolvedPorts: previousResolution,
            }),
            activePtyProcessId: null,
          },
        ],
        latestRun: null,
        onTransition: (input) => transitions.push(input),
      },
    );

    // Same rule as boot repair: making the status honest must not also throw
    // away the allocation the crashed launch had established, because the next
    // launch's preference is the only thing that brings the command back on the
    // address the user still has open.
    const repair = transitions.at(-1);
    assert.equal(repair?.status, 'failed');
    assert.ok(
      repair !== undefined && !('resolvedPorts' in repair),
      'pointerless-state repair must preserve the resolved snapshot by never naming it',
    );
  } finally {
    fixture.cleanup();
  }
});
