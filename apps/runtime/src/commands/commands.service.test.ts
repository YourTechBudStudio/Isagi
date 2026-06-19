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
  type PtyRepositoryService,
  type PtyServiceShape,
} from '../pty-processes/index.js';
import { InternalRuntimeEventBusLive, RuntimeEventBusLive } from '../runtime-events/index.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from '../workspace/index.js';
import { CommandRepository, type CommandRepositoryService } from './commands.repository.js';
import { CommandService, CommandServiceLive } from './commands.service.js';

test('command service returns an empty configured catalog when config is missing', async () => {
  const fixture = createFixture();
  try {
    const output = await runCommandService(fixture.rootPath);

    assert.deepEqual(output, { status: 'configured', worktreeId: 10, commands: [] });
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
    }
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
    }
  } finally {
    fixture.cleanup();
  }
});

async function runCommandService(rootPath: string) {
  return Effect.runPromise(
    CommandService.pipe(
      Effect.flatMap((service) => service.listForWorktree(10)),
      Effect.provide(CommandServiceLive),
      Effect.provide(Layer.succeed(WorkspaceRepository, repository(rootPath))),
      Effect.provide(Layer.succeed(CommandRepository, commandRepository())),
      Effect.provide(Layer.succeed(PtyRepository, ptyRepository())),
      Effect.provide(Layer.succeed(PtyService, ptyService())),
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

function commandRepository(): CommandRepositoryService {
  return {
    listStatesForWorktree: () => Effect.succeed([]),
    findState: () => Effect.succeed(null),
    ensureState: () => Effect.die('ensureState is not used'),
    transitionState: () => Effect.die('transitionState is not used'),
    createRun: () => Effect.die('createRun is not used'),
    updateRunPty: () => Effect.die('updateRunPty is not used'),
    completeRun: () => Effect.die('completeRun is not used'),
    completeRunByPtyProcess: () => Effect.succeed(null),
    findLatestRun: () => Effect.succeed(null),
    findRunByPtyProcess: () => Effect.succeed(null),
    listReferencedPtyProcessIds: Effect.succeed([]),
    listReferencedCommandLogPaths: Effect.succeed([]),
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

function ptyService(): PtyServiceShape {
  return {
    launch: () => Effect.die('launch is not used'),
    getAttachmentPlan: () => Effect.die('getAttachmentPlan is not used'),
    attach: () => Effect.die('attach is not used'),
    replay: () => Effect.void,
    write: () => Effect.void,
    resize: () => Effect.void,
    kill: () => Effect.void,
    terminate: () => Effect.void,
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
