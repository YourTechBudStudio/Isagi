import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createShellIntegrationParser,
  prepareShellIntegration,
  stripShellIntegrationMarkers,
} from './shell-integration.js';

test('shell integration parser strips markers split across PTY chunks', () => {
  const events: string[] = [];
  const parser = createShellIntegrationParser({
    shellIntegration: { token: 'token-1' },
    onEvent: (event) => events.push(event),
  });

  const visible =
    parser.push('before\x1b]6973;isagi;foreground-') +
    parser.push('start;token-1\x07after') +
    parser.flush();

  assert.equal(visible, 'beforeafter');
  assert.deepEqual(events, ['foreground-start']);
});

test('shell integration parser ignores markers with a mismatched token', () => {
  const events: string[] = [];
  const visible = stripShellIntegrationMarkers(
    'a\x1b]6973;isagi;foreground-start;other-token\x07b',
    { token: 'token-1' },
  );

  createShellIntegrationParser({
    shellIntegration: { token: 'token-1' },
    onEvent: (event) => events.push(event),
  }).push('\x1b]6973;isagi;foreground-start;other-token\x07');

  assert.equal(visible, 'ab');
  assert.deepEqual(events, []);
});

test('shell integration parser retains a partial marker prefix until it completes', () => {
  const events: string[] = [];
  const parser = createShellIntegrationParser({
    shellIntegration: { token: 'token-1' },
    onEvent: (event) => events.push(event),
  });

  // The trailing bytes are a genuine prefix of the marker; they must be held back
  // (not emitted as visible output) until the next chunk resolves the ambiguity.
  const first = parser.push('output\x1b]6973;isa');
  assert.equal(first, 'output');
  assert.deepEqual(events, []);

  const second = parser.push('gi;foreground-start;token-1\x07tail');
  assert.equal(second, 'tail');
  assert.deepEqual(events, ['foreground-start']);
});

test('shell integration parser flushes an unterminated marker run once it exceeds the buffer bound', () => {
  const events: string[] = [];
  const parser = createShellIntegrationParser({
    shellIntegration: { token: 'token-1' },
    onEvent: (event) => events.push(event),
  });

  // A marker prefix that never terminates must not be buffered forever: past the
  // bound it is released as visible output so real terminal data is never swallowed.
  const runaway = '\x1b]6973;isagi;' + 'x'.repeat(600);
  const visible = parser.push(runaway) + parser.flush();

  assert.equal(visible, runaway);
  assert.deepEqual(events, []);
});

test('bash shell integration uses an Isagi-scoped rcfile without touching user dotfiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-shell-integration-'));
  try {
    const launch = prepareShellIntegration({
      launch: {
        command: '/bin/bash',
        args: [],
        cwd: '/repo/isagi',
        shellIntegration: true,
      },
      ptyProcessId: 42,
      sessionsPath: root,
      env: { HOME: '/home/dev', PATH: '/bin' },
    });

    assert.equal(launch.command, '/bin/bash');
    assert.equal(launch.args[0], '--rcfile');
    assert.equal(launch.args[2], '-i');
    assert.equal(launch.env.ISAGI_SHELL_INTEGRATION, '1');
    assert.ok(launch.shellIntegration?.token);

    const rcfile = String(launch.args[1]);
    assert.equal(existsSync(rcfile), true);
    assert.match(readFileSync(rcfile, 'utf8'), /HOME\/\.bashrc/);
    assert.match(readFileSync(rcfile, 'utf8'), /__isagi_preexec/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('zsh shell integration redirects ZDOTDIR and preserves the user original', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-shell-integration-'));
  try {
    const launch = prepareShellIntegration({
      launch: {
        command: '/usr/bin/zsh',
        args: [],
        cwd: '/repo/isagi',
        shellIntegration: true,
      },
      ptyProcessId: 7,
      sessionsPath: root,
      env: { HOME: '/home/dev', ZDOTDIR: '/home/dev/.zsh', PATH: '/bin' },
    });

    assert.equal(launch.command, '/usr/bin/zsh');
    assert.deepEqual(launch.args, []);
    assert.equal(launch.env.ISAGI_SHELL_INTEGRATION, '1');
    assert.equal(launch.env.ISAGI_ORIGINAL_ZDOTDIR, '/home/dev/.zsh');
    assert.ok(launch.shellIntegration?.token);

    const zdotdir = String(launch.env.ZDOTDIR);
    assert.notEqual(zdotdir, '/home/dev/.zsh');
    const zshrc = readFileSync(join(zdotdir, '.zshrc'), 'utf8');
    assert.match(zshrc, /add-zsh-hook preexec __isagi_preexec/);
    assert.match(zshrc, /ISAGI_ORIGINAL_ZDOTDIR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fish shell integration sources a generated init file via --init-command', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-shell-integration-'));
  try {
    const launch = prepareShellIntegration({
      launch: {
        command: '/usr/bin/fish',
        args: [],
        cwd: '/repo/isagi',
        shellIntegration: true,
      },
      ptyProcessId: 9,
      sessionsPath: root,
      env: { HOME: '/home/dev', PATH: '/bin' },
    });

    assert.equal(launch.command, '/usr/bin/fish');
    assert.equal(launch.args[0], '--init-command');
    assert.match(String(launch.args[1]), /^source /);
    assert.equal(launch.env.ISAGI_SHELL_INTEGRATION, '1');
    assert.ok(launch.shellIntegration?.token);

    const initFile = String(launch.args[1])
      .replace(/^source '?/, '')
      .replace(/'$/, '');
    assert.match(readFileSync(initFile, 'utf8'), /--on-event fish_preexec/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shell integration degrades to a plain shell when the rc files cannot be written', () => {
  // Point the sessions path at a regular file so the rc-file mkdir fails with
  // ENOTDIR: the launch must fall back to a normal shell with no token and no
  // integration args rather than surfacing the write failure.
  const root = mkdtempSync(join(tmpdir(), 'isagi-shell-integration-'));
  try {
    const notADir = join(root, 'sessions-is-a-file');
    writeFileSync(notADir, '');
    const launch = prepareShellIntegration({
      launch: {
        command: '/bin/bash',
        args: ['--login'],
        cwd: '/repo/isagi',
        shellIntegration: true,
      },
      ptyProcessId: 1,
      sessionsPath: notADir,
      env: { HOME: '/home/dev', PATH: '/bin' },
    });

    assert.deepEqual(launch, {
      command: '/bin/bash',
      args: ['--login'],
      env: { HOME: '/home/dev', PATH: '/bin' },
      shellIntegration: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported shells keep the original launch envelope and no integration token', () => {
  const launch = prepareShellIntegration({
    launch: {
      command: '/bin/nu',
      args: ['--login'],
      cwd: '/repo/isagi',
      shellIntegration: true,
    },
    ptyProcessId: 42,
    sessionsPath: '/tmp/isagi-shell-integration-test',
    env: { PATH: '/bin' },
  });

  assert.deepEqual(launch, {
    command: '/bin/nu',
    args: ['--login'],
    env: { PATH: '/bin' },
    shellIntegration: null,
  });
});
