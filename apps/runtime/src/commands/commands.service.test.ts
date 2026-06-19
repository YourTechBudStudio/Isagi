import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { WorkspaceRepository, type WorkspaceRepositoryService } from '../workspace/index.js';
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
      commands: [{ name: 'dev server', status: 'idle', ports: [5173] }],
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
    ),
  );
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
