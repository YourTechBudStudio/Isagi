import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResolvedEditorInstallation } from '../../editor-provisioning/index.js';
import {
  editorLaunchSpec,
  editorLoopbackHost,
  editorOrigin,
  editorSessionSocketPath,
  maxSessionSocketPathBytes,
} from '../launch-spec.js';

function installation(
  overrides: Partial<ResolvedEditorInstallation> = {},
): ResolvedEditorInstallation {
  return {
    version: '4.135.0',
    installRoot: '/data/tools/code-server/4.135.0',
    executablePath: '/data/tools/code-server/4.135.0/bin/code-server',
    userDataPath: '/data/editors/code-server/user-data',
    extensionsPath: '/data/editors/code-server/extensions',
    sessionSocketDirectory: '/data/editors/code-server/sock',
    configPath: '/data/editors/code-server/config.yaml',
    ...overrides,
  };
}

test('the launch spec is the executable and the exact argument set, in order', () => {
  const spec = editorLaunchSpec({
    installation: installation(),
    worktreePath: '/repo/isagi',
    port: 41_287,
    socketPath: '/data/editors/code-server/sock/7-a1b2c3.sock',
  });

  assert.equal(spec.command, '/data/tools/code-server/4.135.0/bin/code-server');
  assert.deepEqual(spec.args, [
    '--bind-addr',
    '127.0.0.1:41287',
    '--auth',
    'none',
    '--disable-telemetry',
    '--disable-update-check',
    '--disable-workspace-trust',
    '--user-data-dir',
    '/data/editors/code-server/user-data',
    '--extensions-dir',
    '/data/editors/code-server/extensions',
    '--config',
    '/data/editors/code-server/config.yaml',
    '--session-socket',
    '/data/editors/code-server/sock/7-a1b2c3.sock',
    '--ignore-last-opened',
    '/repo/isagi',
  ]);
});

test('the worktree path is the last argument and is never quoted or escaped', () => {
  const spec = editorLaunchSpec({
    installation: installation(),
    worktreePath: '/repo/my project/isagi',
    port: 41_287,
    socketPath: '/data/editors/code-server/sock/7-a1b2c3.sock',
  });

  // Structured argv is what makes a path containing a space a path rather than
  // two arguments; a quoting helper here would be the bug, not the fix.
  assert.equal(spec.args.at(-1), '/repo/my project/isagi');
  assert.equal(spec.args.filter((arg) => arg.includes('my project')).length, 1);
});

test('the two flags that carry the story requirements are present', () => {
  const spec = editorLaunchSpec({
    installation: installation(),
    worktreePath: '/repo/isagi',
    port: 41_287,
    socketPath: '/data/editors/code-server/sock/7-a1b2c3.sock',
  });

  const flagValue = (flag: string) => spec.args[spec.args.indexOf(flag) + 1];
  assert.equal(flagValue('--auth'), 'none');
  assert.ok(spec.args.includes('--ignore-last-opened'));
  assert.ok(spec.args.includes('--disable-workspace-trust'));
});

test('the bind address and the framed origin agree on the loopback host', () => {
  const spec = editorLaunchSpec({
    installation: installation(),
    worktreePath: '/repo/isagi',
    port: 41_287,
    socketPath: '/s.sock',
  });

  assert.equal(spec.args[spec.args.indexOf('--bind-addr') + 1], `${editorLoopbackHost}:41287`);
  assert.equal(editorOrigin(editorLoopbackHost, 41_287), 'http://127.0.0.1:41287');
});

test('the socket path is per incarnation, not per context', () => {
  const first = editorSessionSocketPath('/data/editors/code-server/sock', 7, 'a1b2c3');
  const second = editorSessionSocketPath('/data/editors/code-server/sock', 7, 'd4e5f6');

  assert.equal(first, '/data/editors/code-server/sock/7-a1b2c3.sock');
  assert.notEqual(first, second);
});

test('a deep editors path produces a socket path over the byte cap', () => {
  const deep = `/Users/somebody/Library/Application Support/Isagi/${'nested/'.repeat(8)}editors/code-server/sock`;
  const socketPath = editorSessionSocketPath(deep, 1_234, 'a1b2c3');

  // The refusal itself lives in the launch sequence; what this pins is that a
  // realistic deep data directory genuinely crosses the cap, so that guard is
  // reachable rather than theoretical.
  assert.ok(Buffer.byteLength(socketPath) > maxSessionSocketPathBytes);
});
