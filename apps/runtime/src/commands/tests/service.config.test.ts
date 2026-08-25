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
      - port: 5173
        paths:
          - label: app
            path: /
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
      - port: 5173
        paths:
          - label: app
            path: /
`,
    );

    const output = await runCommandService(fixture.rootPath, {
      states: [
        commandState({
          commandName: 'dev',
          status: 'running',
          resolvedPorts: [{ envVar: null, port: 5173, paths: [{ label: 'app', path: '/' }] }],
        }),
        // No snapshot: a running command whose resolution is unknown reports
        // the honest degraded `null`, not an empty list.
        commandState({ commandName: 'old dev', status: 'running' }),
        commandState({ commandName: 'old failed', status: 'failed' }),
        commandState({ commandName: 'old stopped', status: 'stopped' }),
      ],
    });

    assert.deepEqual(output, {
      status: 'configured',
      worktreeId: 10,
      commands: [
        {
          name: 'dev',
          status: 'running',
          ports: [
            {
              port: 5173,
              envVar: null,
              urls: [{ label: 'app', path: '/', url: 'http://localhost:5173/' }],
            },
          ],
        },
      ],
      removedCommands: [
        { name: 'old dev', status: 'running', ports: null },
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
        { name: 'dev', status: 'running', ports: null },
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

/**
 * The projection reads the durable snapshot, never fresh config.
 *
 * That is the honesty guarantee the old config-echo could not make: a running
 * incarnation reports the ports its process actually received, so editing the
 * config mid-run cannot retroactively rewrite what a live command claims, and a
 * command deleted from config keeps reporting its real endpoints until it stops.
 */
test('a running command reports its snapshot, not the config it was launched from', async () => {
  const fixture = createFixture();
  try {
    // The config now declares a *different* port than the one the running
    // incarnation was given — a mid-run edit.
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
    ports:
      - port: 4000
        paths:
          - label: edited
            path: /edited
`,
    );

    const output = await runCommandService(fixture.rootPath, {
      states: [
        commandState({
          commandName: 'dev',
          status: 'running',
          resolvedPorts: [
            { envVar: 'API_PORT', port: 5173, paths: [{ label: 'api', path: '/api' }] },
          ],
        }),
      ],
    });

    assert.equal(output.status, 'configured');
    if (output.status === 'configured') {
      assert.deepEqual(output.commands[0]?.ports, [
        {
          port: 5173,
          envVar: 'API_PORT',
          urls: [{ label: 'api', path: '/api', url: 'http://localhost:5173/api' }],
        },
      ]);
    }
  } finally {
    fixture.cleanup();
  }
});

test('resolved-port metadata is exposed only while a command is running', async () => {
  const fixture = createFixture();
  try {
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: dev
    command: pnpm dev
    ports:
      - port: 5173
`,
    );

    // The snapshot survives the stop — it is the next launch's preference —
    // but a stopped command has no live endpoints to report.
    const output = await runCommandService(fixture.rootPath, {
      states: [
        commandState({
          commandName: 'dev',
          status: 'stopped',
          resolvedPorts: [{ envVar: null, port: 5173, paths: [] }],
        }),
      ],
    });

    assert.equal(output.status, 'configured');
    if (output.status === 'configured') {
      assert.deepEqual(output.commands[0], { name: 'dev', status: 'stopped', ports: [] });
    }
  } finally {
    fixture.cleanup();
  }
});

test('a running command that declared no ports reports an empty list, not unknown', async () => {
  const fixture = createFixture();
  try {
    writeConfig(fixture.rootPath, `\ncommands:\n  - name: dev\n    command: pnpm dev\n`);

    const output = await runCommandService(fixture.rootPath, {
      states: [commandState({ commandName: 'dev', status: 'running', resolvedPorts: [] })],
    });

    assert.equal(output.status, 'configured');
    if (output.status === 'configured') {
      assert.deepEqual(output.commands[0], { name: 'dev', status: 'running', ports: [] });
    }
  } finally {
    fixture.cleanup();
  }
});

test('a running command keeps its resolved ports after config removes it', async () => {
  const fixture = createFixture();
  try {
    // The config no longer names `dev` at all.
    writeConfig(
      fixture.rootPath,
      `
commands:
  - name: other
    command: pnpm other
`,
    );

    const output = await runCommandService(fixture.rootPath, {
      states: [
        commandState({
          commandName: 'dev',
          status: 'running',
          resolvedPorts: [
            { envVar: 'API_PORT', port: 51824, paths: [{ label: 'api', path: '/v1' }] },
          ],
        }),
      ],
    });

    // The process is still running on 51824 whatever the file says, and the
    // snapshot is the only thing that could still know that. A config echo could
    // not have reported anything here at all.
    assert.deepEqual(output.status === 'configured' ? output.removedCommands : null, [
      {
        name: 'dev',
        status: 'running',
        ports: [
          {
            port: 51824,
            envVar: 'API_PORT',
            urls: [{ label: 'api', path: '/v1', url: 'http://localhost:51824/v1' }],
          },
        ],
      },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('a managed running command reports its resolved ports when config cannot be parsed', async () => {
  const fixture = createFixture();
  try {
    writeConfig(fixture.rootPath, 'commands: [');

    const output = await runCommandService(fixture.rootPath, {
      states: [
        commandState({
          commandName: 'dev',
          status: 'running',
          resolvedPorts: [{ envVar: 'API_PORT', port: 51824, paths: [] }],
        }),
      ],
    });

    // Same argument, harder case: there is no config to echo even in principle.
    assert.deepEqual(output.status === 'config_error' ? output.managedCommands : null, [
      { name: 'dev', status: 'running', ports: [{ port: 51824, envVar: 'API_PORT', urls: [] }] },
    ]);
  } finally {
    fixture.cleanup();
  }
});
