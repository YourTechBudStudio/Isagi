import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  commandRun,
  commandState,
  createFixture,
  runCommandService,
  runCommandServiceEffect,
  writeConfig,
} from './test-support.js';

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
