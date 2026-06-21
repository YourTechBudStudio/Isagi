import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { PtyServiceError } from '../../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { type CommandRunRow } from '../commands.repository.js';
import { CommandService } from '../commands.service.js';
import {
  commandRun,
  commandState,
  createFixture,
  runCommandServiceEffect,
  writeConfig,
} from './test-support.js';

test('command service stops a running removed managed command', async () => {
  const fixture = createFixture();
  const terminated: number[] = [];
  const transitioned: Array<{ readonly commandName: string; readonly status: string }> = [];
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
          launch: () =>
            Effect.fail(
              new PtyServiceError({
                code: 'backend_unavailable',
                message: 'launch failed',
              }),
            ),
        },
      },
    );

    assert.equal(output.action.summary.status, 'failed');
    assert.equal(output.metadata.status, 'failed');
    assert.equal(output.metadata.latestRun?.diagnostic?.reason, 'pty_launch_failed');
    assert.equal(output.metadata.latestRun?.diagnostic?.detail, 'launch failed');
  } finally {
    fixture.cleanup();
  }
});

test('command service maps non-zero process exits to failed command state', async () => {
  const fixture = createFixture();
  const transitioned: Array<{ readonly commandName: string; readonly status: string }> = [];
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

test('command service records a successful run and retains its log after the process exits', async () => {
  const fixture = createFixture();
  const transitioned: Array<{ readonly commandName: string; readonly status: string }> = [];
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
          launch: () =>
            Effect.succeed({
              ptyProcessId: 901,
              command: '/bin/sh',
              args: ['-lc', 'pnpm dev'],
              cwd: fixture.rootPath,
              logPath: ptyLogPath,
            }),
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

test('command service marks stale running commands as failed on reconcile', async () => {
  const fixture = createFixture();
  const transitioned: Array<{ readonly commandName: string; readonly status: string }> = [];
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
      (service) => service.reconcileStaleRunningCommands,
      {
        states: [commandState({ commandName: 'dev', status: 'running' })],
        runningStates: [commandState({ commandName: 'dev', status: 'running' })],
        runs,
        onTransition: (input) => transitioned.push(input),
      },
    );

    assert.equal(runs[0]?.status, 'failed');
    assert.equal(runs[0]?.diagnosticReason, 'runtime_stopped');
    assert.ok(
      transitioned.some(
        (transition) => transition.commandName === 'dev' && transition.status === 'failed',
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
