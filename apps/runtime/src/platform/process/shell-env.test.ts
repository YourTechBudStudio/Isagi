import assert from 'node:assert/strict';
import { delimiter, dirname } from 'node:path';
import test from 'node:test';

import { launchEnv, userShellBaseEnv } from './shell-env.js';

const nodeBin = dirname(process.execPath);

test('launch env prepends the runtime node bin when PATH lacks it', () => {
  const entries = (launchEnv({ PATH: ['/usr/bin', '/bin'].join(delimiter) }).PATH ?? '').split(
    delimiter,
  );
  assert.deepEqual(entries, [nodeBin, '/usr/bin', '/bin']);
});

test('launch env keeps the runtime node bin present without duplicating it', () => {
  const entries = (
    launchEnv({ PATH: ['/usr/bin', nodeBin, '/bin'].join(delimiter) }).PATH ?? ''
  ).split(delimiter);
  // Already-present node bin stays in place rather than being prepended again.
  assert.deepEqual(entries, ['/usr/bin', nodeBin, '/bin']);
});

test('launch env falls back to just the runtime node bin when PATH is unset', () => {
  assert.equal(launchEnv({}).PATH, nodeBin);
});

test('user process environment removes runtime-owned controls without losing user identity', () => {
  const environment = userShellBaseEnv({
    USER: 'yourtechbud',
    HOME: '/Users/yourtechbud',
    SHELL: '/bin/zsh',
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOST: '127.0.0.1',
    PORT: '0',
    ELECTRON_RUN_AS_NODE: '1',
    ISAGI_ALLOWED_ORIGINS: 'file://',
    ISAGI_DATA_DIR: '/runtime/data',
    ISAGI_RUNTIME_DEBUG: '1',
    VITE_ISAGI_RUNTIME_URL: 'http://127.0.0.1:1234',
  });

  assert.deepEqual(environment, {
    USER: 'yourtechbud',
    HOME: '/Users/yourtechbud',
    SHELL: '/bin/zsh',
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  });
});

test('user process environment drops the launching terminal identity but keeps the host and Isagi terminal', () => {
  const environment = userShellBaseEnv({
    HOME: '/home/developer',
    TERM: 'tmux-256color',
    COLORTERM: '24bit',
    TMUX: '/tmp/tmux-501/default,123,0',
    TMUX_PANE: '%1',
    STY: '123.pts-0.host',
    ZELLIJ: '0',
    ZELLIJ_SESSION_NAME: 'main',
    TERM_PROGRAM: 'iTerm.app',
    TERM_PROGRAM_VERSION: '3.5.0',
    TERM_SESSION_ID: 'w0t0p0',
    LC_TERMINAL: 'iTerm2',
    LC_TERMINAL_VERSION: '3.5.0',
    VTE_VERSION: '7600',
    ITERM_SESSION_ID: 'w0t0p0:abc',
    ITERM_PROFILE: 'Default',
    KITTY_WINDOW_ID: '1',
    KITTY_PID: '42',
    WEZTERM_PANE: '0',
    WEZTERM_EXECUTABLE: '/usr/bin/wezterm',
    WT_SESSION: 'guid',
    WT_PROFILE_ID: 'guid',
    ALACRITTY_WINDOW_ID: '1',
    ALACRITTY_SOCKET: '/tmp/alacritty.sock',
    GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty',
    GHOSTTY_BIN_DIR: '/usr/bin',
    KONSOLE_VERSION: '230800',
    KONSOLE_DBUS_SESSION: '/Sessions/1',
    KONSOLE_DBUS_SERVICE: 'org.kde.konsole',
    XTERM_VERSION: 'XTerm(390)',
    TERMINAL_EMULATOR: 'JetBrains-JediTerm',
    GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/1',
    GNOME_TERMINAL_SERVICE: ':1.42',
    SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    SSH_TTY: '/dev/pts/0',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
  });

  assert.deepEqual(environment, {
    HOME: '/home/developer',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    SSH_TTY: '/dev/pts/0',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
  });
});
