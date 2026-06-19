import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { DataDirectory } from '../persistence/index.js';
import {
  PtyRepository,
  PtyService,
  PtyServiceError,
  type PtyRepositoryService,
  type PtyServiceShape,
} from '../pty-processes/index.js';
import {
  InternalRuntimeEventBus,
  InternalRuntimeEventBusLive,
  type InternalRuntimeEventBusService,
  RuntimeEventBusLive,
} from '../runtime-events/index.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from '../workspace/index.js';
import {
  CommandRepository,
  type CommandRepositoryService,
  type CommandRunRow,
  type CommandStateRow,
} from './commands.repository.js';
import { CommandService, CommandServiceLive } from './commands.service.js';

test('command service returns an empty configured catalog when config is missing', async () => {
  const fixture = createFixture();
  try {
    const output = await runCommandService(fixture.rootPath);

    assert.deepEqual(output, {
      status: 'configured',
      worktreeId: 10,
      commands: [],
      removedCommands: [],
    });
  } finally {
    fixture.cleanup();
  }
});

test('command service reads command summaries from the worktree config', async () => {
  const fixture = createFixture();
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev server
    command: pnpm dev
    cwd: apps/web
    ports:
      - 5173
`,
    );

    const output = await runCommandService(fixture.rootPath);

    assert.deepEqual(output, {
      status: 'configured',
      worktreeId: 10,
      commands: [{ name: 'dev server', status: 'idle', ports: [] }],
      removedCommands: [],
    });
  } finally {
    fixture.cleanup();
  }
});

test('command service surfaces running and failed removed commands separately', async () => {
  const fixture = createFixture();
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
    ports:
      - 5173
`,
    );

    const output = await runCommandService(fixture.rootPath, {
      states: [
        commandState({ commandName: 'dev', status: 'running' }),
        commandState({ commandName: 'old dev', status: 'running' }),
        commandState({ commandName: 'old failed', status: 'failed' }),
        commandState({ commandName: 'old stopped', status: 'stopped' }),
      ],
    });

    assert.deepEqual(output, {
      status: 'configured',
      worktreeId: 10,
      commands: [{ name: 'dev', status: 'running', ports: [5173] }],
      removedCommands: [
        { name: 'old dev', status: 'running', ports: [] },
        { name: 'old failed', status: 'failed', ports: [] },
      ],
    });
  } finally {
    fixture.cleanup();
  }
});

test('command service returns config diagnostics for malformed command config', async () => {
  const fixture = createFixture();
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
    ports:
      - 0
`,
    );

    const output = await runCommandService(fixture.rootPath);

    assert.equal(output.status, 'config_error');
    if (output.status === 'config_error') {
      assert.equal(output.worktreeId, 10);
      assert.equal(output.diagnostic.code, 'command_config_invalid');
      assert.equal(output.diagnostic.path, join(fixture.rootPath, '.isagi', 'config.yaml'));
      assert.match(output.diagnostic.message, /ports\[0\]/);
      assert.deepEqual(output.managedCommands, []);
    }
  } finally {
    fixture.cleanup();
  }
});

test('command service keeps managed command controls visible when config is malformed', async () => {
  const fixture = createFixture();
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
    ports:
      - 0
`,
    );

    const output = await runCommandService(fixture.rootPath, {
      states: [
        commandState({ commandName: 'dev', status: 'running' }),
        commandState({ commandName: 'test', status: 'failed' }),
        commandState({ commandName: 'done', status: 'exited' }),
      ],
    });

    assert.equal(output.status, 'config_error');
    if (output.status === 'config_error') {
      assert.deepEqual(output.managedCommands, [
        { name: 'dev', status: 'running', ports: [] },
        { name: 'test', status: 'failed', ports: [] },
      ]);
    }
  } finally {
    fixture.cleanup();
  }
});

test('command service reads metadata for a removed managed command', async () => {
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
      (service) => service.readLogMetadata({ worktreeId: 10, commandName: 'old dev' }),
      {
        states: [commandState({ commandName: 'old dev', status: 'failed' })],
        latestRun: commandRun({ commandName: 'old dev', status: 'failed' }),
      },
    );

    assert.equal(output.status, 'failed');
    assert.equal(output.latestRun?.status, 'failed');
    assert.equal(output.latestRun?.hasPtyProcess, false);
  } finally {
    fixture.cleanup();
  }
});

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

test('command service returns config diagnostics when the config path exists but cannot be read as a file', async () => {
  const fixture = createFixture();
  try {
    mkdirSync(join(fixture.rootPath, '.isagi', 'config.yaml'), { recursive: true });

    const output = await runCommandService(fixture.rootPath);

    assert.equal(output.status, 'config_error');
    if (output.status === 'config_error') {
      assert.equal(output.diagnostic.code, 'command_config_invalid');
      assert.equal(output.diagnostic.path, join(fixture.rootPath, '.isagi', 'config.yaml'));
      assert.match(output.diagnostic.message, /EISDIR|illegal operation|directory/i);
      assert.deepEqual(output.managedCommands, []);
    }
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

async function runCommandService(rootPath: string, options: CommandRepositoryOptions = {}) {
  return runCommandServiceEffect(rootPath, (service) => service.listForWorktree(10), options);
}

async function runCommandServiceEffect<A>(
  rootPath: string,
  effect: (
    service: import('./commands.service.js').CommandService,
  ) => Effect.Effect<
    A,
    unknown,
    import('./commands.service.js').CommandService | InternalRuntimeEventBusService
  >,
  options: CommandRepositoryOptions = {},
) {
  return Effect.runPromise(
    CommandService.pipe(
      Effect.flatMap(effect),
      Effect.provide(CommandServiceLive),
      Effect.provide(Layer.succeed(WorkspaceRepository, repository(rootPath))),
      Effect.provide(Layer.succeed(CommandRepository, commandRepository(options))),
      Effect.provide(Layer.succeed(PtyRepository, ptyRepository())),
      Effect.provide(Layer.succeed(PtyService, ptyService(options.pty))),
      Effect.provide(
        Layer.succeed(DataDirectory, {
          paths: {
            root: rootPath,
            databasePath: join(rootPath, 'isagi.db'),
            statePath: join(rootPath, 'state.json'),
            worktreesPath: join(rootPath, 'worktrees'),
            sessionsPath: join(rootPath, 'sessions'),
          },
        }),
      ),
      Effect.provide(RuntimeEventBusLive),
      Effect.provide(InternalRuntimeEventBusLive),
    ),
  );
}

interface CommandRepositoryOptions {
  readonly states?: readonly CommandStateRow[];
  readonly runningStates?: readonly CommandStateRow[] | undefined;
  readonly runs?: CommandRunRow[] | undefined;
  readonly latestRun?: CommandRunRow | null | undefined;
  readonly pty?: Partial<PtyServiceShape> | undefined;
  readonly onTransition?:
    | ((input: {
        readonly commandName: string;
        readonly status: CommandStateRow['status'];
      }) => void)
    | undefined;
}

function commandRepository(options: CommandRepositoryOptions = {}): CommandRepositoryService {
  const states = [...(options.states ?? [])];
  const runs = options.runs ?? [];
  return {
    listStatesForWorktree: (worktreeId) =>
      Effect.succeed(states.filter((state) => state.worktreeId === worktreeId)),
    findState: (input) =>
      Effect.succeed(
        states.find(
          (state) =>
            state.worktreeId === input.worktreeId && state.commandName === input.commandName,
        ) ?? null,
      ),
    listRunningStates: Effect.succeed([...(options.runningStates ?? [])]),
    listRunningStatesForWorktree: (worktreeId) =>
      Effect.succeed(
        (options.runningStates ?? []).filter((state) => state.worktreeId === worktreeId),
      ),
    ensureState: () => Effect.die('ensureState is not used'),
    transitionState: (input) =>
      Effect.sync(() => {
        options.onTransition?.({ commandName: input.commandName, status: input.status });
        const existing = states.find(
          (state) =>
            state.worktreeId === input.worktreeId && state.commandName === input.commandName,
        );
        const next = {
          ...(existing ?? commandState({ commandName: input.commandName, status: input.status })),
          status: input.status,
          activePtyProcessId: input.activePtyProcessId ?? null,
        };
        if (existing) {
          states.splice(states.indexOf(existing), 1, next);
        } else {
          states.push(next);
        }
        return next;
      }),
    createRun: (input) =>
      Effect.sync(() => {
        const run = commandRun({
          commandName: input.commandName,
          status: input.status,
          ptyProcessId: input.ptyProcessId,
          diagnosticReason: input.diagnosticReason,
          diagnosticDetail: input.diagnosticDetail,
        });
        runs.push({
          ...run,
          id: runs.length + 1,
          worktreeId: input.worktreeId,
          completedAt: input.completedAt ?? run.completedAt,
        });
        return runs.at(-1)!;
      }),
    updateRunPty: (input) =>
      Effect.sync(() => {
        const run = runs.find((candidate) => candidate.id === input.runId);
        if (!run) return options.latestRun ?? null;
        const updated = { ...run, ptyProcessId: input.ptyProcessId };
        runs.splice(runs.indexOf(run), 1, updated);
        return updated;
      }),
    completeRun: (input) =>
      Effect.sync(() => {
        const run = runs.find((candidate) => candidate.id === input.runId);
        if (!run) return options.latestRun ?? null;
        const updated = {
          ...run,
          status: input.status,
          diagnosticReason: input.diagnosticReason ?? null,
          diagnosticDetail: input.diagnosticDetail ?? null,
          completedAt: '2026-06-19T00:00:01.000Z',
        };
        runs.splice(runs.indexOf(run), 1, updated);
        return updated;
      }),
    completeRunByPtyProcess: (input) =>
      Effect.sync(() => {
        const run = runs.find((candidate) => candidate.ptyProcessId === input.ptyProcessId);
        if (!run) return options.latestRun ?? null;
        const updated = {
          ...run,
          status: input.status,
          diagnosticReason: input.diagnosticReason ?? null,
          diagnosticDetail: input.diagnosticDetail ?? null,
          completedAt: '2026-06-19T00:00:01.000Z',
        };
        runs.splice(runs.indexOf(run), 1, updated);
        return updated;
      }),
    findLatestRun: (input) =>
      Effect.succeed(
        runs
          .filter(
            (run) => run.worktreeId === input.worktreeId && run.commandName === input.commandName,
          )
          .at(-1) ??
          options.latestRun ??
          null,
      ),
    findRunByPtyProcess: (ptyProcessId) =>
      Effect.succeed(
        runs.find((run) => run.ptyProcessId === ptyProcessId) ?? options.latestRun ?? null,
      ),
    pruneRunHistory: (input) =>
      Effect.sync(() => {
        const matching = runs
          .filter(
            (run) => run.worktreeId === input.worktreeId && run.commandName === input.commandName,
          )
          .sort((a, b) => b.id - a.id);
        const stale = matching.slice(Math.max(input.keep, 0));
        for (const run of stale) {
          const index = runs.indexOf(run);
          if (index >= 0) runs.splice(index, 1);
        }
        return stale;
      }),
    listReferencedPtyProcessIds: Effect.succeed([]),
  };
}

function commandState(input: {
  readonly commandName: string;
  readonly status: CommandStateRow['status'];
}): CommandStateRow {
  return {
    id: 1,
    worktreeId: 10,
    commandName: input.commandName,
    status: input.status,
    activePtyProcessId: input.status === 'running' ? 123 : null,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
  };
}

function commandRun(input: {
  readonly commandName: string;
  readonly status: CommandRunRow['status'];
  readonly ptyProcessId?: number | null | undefined;
  readonly diagnosticReason?: CommandRunRow['diagnosticReason'] | undefined;
  readonly diagnosticDetail?: string | null | undefined;
}): CommandRunRow {
  return {
    id: 1,
    worktreeId: 10,
    commandName: input.commandName,
    ptyProcessId: input.ptyProcessId ?? null,
    status: input.status,
    diagnosticReason: input.diagnosticReason ?? null,
    diagnosticDetail: input.diagnosticDetail ?? null,
    startedAt: '2026-06-19T00:00:00.000Z',
    completedAt: input.status === 'running' ? null : '2026-06-19T00:00:01.000Z',
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
  };
}

function ptyRepository(): PtyRepositoryService {
  return {
    createProcessMetadata: () => Effect.die('createProcessMetadata is not used'),
    findProcess: () => Effect.succeed(null),
    listProcessLogPaths: Effect.succeed([]),
    listOrphanProcesses: Effect.succeed([]),
    listProcesses: () => Effect.succeed([]),
    deleteProcess: () => Effect.void,
    updateBackendRef: () => Effect.void,
    updateBackendMetadata: () => Effect.void,
    transitionProcess: () => Effect.void,
  };
}

function ptyService(overrides: Partial<PtyServiceShape> = {}): PtyServiceShape {
  return {
    launch: overrides.launch ?? (() => Effect.die('launch is not used')),
    getAttachmentPlan: () => Effect.die('getAttachmentPlan is not used'),
    attach: () => Effect.die('attach is not used'),
    replay: () => Effect.void,
    canObserveOutput: () => Effect.die('canObserveOutput is not used'),
    observeOutput: () => Effect.die('observeOutput is not used'),
    write: () => Effect.void,
    resize: () => Effect.void,
    kill: () => Effect.void,
    terminate: overrides.terminate ?? (() => Effect.void),
  };
}

function repository(rootPath: string): WorkspaceRepositoryService {
  return {
    findProject: () => Effect.succeed(null),
    findProjectByRootPath: () => Effect.succeed(null),
    findWorktree: (worktreeId) =>
      Effect.succeed(
        worktreeId === 10
          ? {
              id: 10,
              projectId: 1,
              path: rootPath,
              branch: 'main',
              head: 'abcdef0',
              createdAt: '2026-06-19T00:00:00.000Z',
              updatedAt: '2026-06-19T00:00:00.000Z',
              firstSeenAt: '2026-06-19T00:00:00.000Z',
              lastSeenAt: '2026-06-19T00:00:00.000Z',
            }
          : null,
      ),
    findProjectWorktree: () => Effect.succeed(null),
    findProjectRootWorktree: () => Effect.succeed(null),
    findProjectWorktreeByBranch: () => Effect.succeed(null),
    deleteProject: () => Effect.succeed(false),
    deleteWorktree: () => Effect.succeed(false),
    insertProject: () => Effect.succeed(1),
    listProjects: Effect.succeed([]),
    listWorktrees: Effect.succeed([]),
    reconcileProjectWorktrees: () => Effect.succeed({ added: [], missing: [] }),
    restoreProjectAtRootPath: () => Effect.succeed({ added: [], missing: [] }),
    setProjectStatus: () => Effect.void,
  };
}

function createFixture() {
  const rootPath = mkdtempSync(join(tmpdir(), 'isagi-command-worktree-'));
  return {
    rootPath,
    cleanup: () => rmSync(rootPath, { recursive: true, force: true }),
  };
}

function writeConfig(rootPath: string, contents: string) {
  const configDir = join(rootPath, '.isagi');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), contents);
}
