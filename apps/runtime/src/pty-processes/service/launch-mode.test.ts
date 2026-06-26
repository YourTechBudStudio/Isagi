import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { backendLaunchCommand } from './launch-mode.js';

test('direct launch mode preserves the original command and structured args', () => {
  assert.deepEqual(
    backendLaunchCommand({
      launch: {
        command: 'git',
        args: ['status', '--short'],
        cwd: '/repo/isagi',
      },
      env: { SHELL: '/bin/zsh', PATH: '/bin' },
    }),
    {
      command: 'git',
      args: ['status', '--short'],
    },
  );
});

test('user shell launch mode runs simple commands through zsh login interactive rc files', () => {
  assert.deepEqual(
    backendLaunchCommand({
      launch: {
        command: 'codex',
        args: ['--model', 'gpt-5.4', 'resume', 'session-123'],
        cwd: '/repo/isagi',
        launchMode: 'user_shell',
      },
      env: { SHELL: '/bin/zsh', PATH: '/bin' },
    }),
    {
      command: '/bin/zsh',
      args: ['-lic', 'codex "$@"', '--', '--model', 'gpt-5.4', 'resume', 'session-123'],
    },
  );
});

test('user shell launch mode preserves structured args with shell-sensitive bytes', () => {
  assert.deepEqual(
    backendLaunchCommand({
      launch: {
        command: 'claude',
        args: ['--settings', '/tmp/isagi settings.json', "quote'arg", '`ticks`', 'abc$(nope)'],
        cwd: '/repo/isagi',
        launchMode: 'user_shell',
      },
      env: { SHELL: '/bin/bash', PATH: '/bin' },
    }),
    {
      command: '/bin/bash',
      args: [
        '-ic',
        'claude "$@"',
        '--',
        '--settings',
        '/tmp/isagi settings.json',
        "quote'arg",
        '`ticks`',
        'abc$(nope)',
      ],
    },
  );
});

test('user shell launch mode uses fish argv syntax', () => {
  assert.deepEqual(
    backendLaunchCommand({
      launch: {
        command: 'opencode',
        args: ['run', '--format', 'json', 'judge this'],
        cwd: '/repo/isagi',
        launchMode: 'user_shell',
      },
      env: { SHELL: '/opt/homebrew/bin/fish', PATH: '/bin' },
    }),
    {
      command: '/opt/homebrew/bin/fish',
      args: [
        '--login',
        '--interactive',
        '--command',
        'opencode $argv',
        'run',
        '--format',
        'json',
        'judge this',
      ],
    },
  );
});

test('user shell launch mode falls back to direct for unsafe command names', () => {
  assert.deepEqual(
    backendLaunchCommand({
      launch: {
        command: 'codex --danger',
        args: ['prompt'],
        cwd: '/repo/isagi',
        launchMode: 'user_shell',
      },
      env: { SHELL: '/bin/zsh', PATH: '/bin' },
    }),
    {
      command: 'codex --danger',
      args: ['prompt'],
    },
  );
});

test(
  'zsh user shell launch mode expands aliases from zshrc',
  { skip: !existsSync('/bin/zsh') },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'isagi-user-shell-zsh-'));
    try {
      writeFileSync(join(root, '.zshrc'), 'alias codex=\'printf "alias:%s:%s\\\\n"\'\n', 'utf8');
      const launch = backendLaunchCommand({
        launch: {
          command: 'codex',
          args: ['one', 'two'],
          cwd: '/repo/isagi',
          launchMode: 'user_shell',
        },
        env: { SHELL: '/bin/zsh', ZDOTDIR: root, PATH: '/bin:/usr/bin' },
      });

      const result = spawnSync(launch.command, launch.args, {
        encoding: 'utf8',
        env: { SHELL: '/bin/zsh', ZDOTDIR: root, PATH: '/bin:/usr/bin' },
      });

      assert.equal(result.status, 0);
      assert.equal(result.stdout, 'alias:one:two\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'bash user shell launch mode expands aliases from bashrc',
  { skip: !existsSync('/bin/bash') },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'isagi-user-shell-bash-'));
    try {
      writeFileSync(join(root, '.bashrc'), 'alias codex=\'printf "alias:%s:%s\\\\n"\'\n', 'utf8');
      const launch = backendLaunchCommand({
        launch: {
          command: 'codex',
          args: ['one', 'two'],
          cwd: '/repo/isagi',
          launchMode: 'user_shell',
        },
        env: { SHELL: '/bin/bash', HOME: root, PATH: '/bin:/usr/bin' },
      });

      const result = spawnSync(launch.command, launch.args, {
        encoding: 'utf8',
        env: { SHELL: '/bin/bash', HOME: root, PATH: '/bin:/usr/bin' },
      });

      assert.equal(result.status, 0);
      assert.equal(result.stdout, 'alias:one:two\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
