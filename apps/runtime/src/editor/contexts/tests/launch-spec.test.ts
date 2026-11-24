import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResolvedEditorInstallation } from '../../provisioning/install.js';
import {
  editorIncarnationSockets,
  editorLaunchSpec,
  editorSessionSocketPath,
  editorUpstreamHost,
  editorUpstreamOrigin,
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
    listenSocketPath: '/data/editors/code-server/sock/7-a1b2c3-w.sock',
    sessionSocketPath: '/data/editors/code-server/sock/7-a1b2c3.sock',
  });

  assert.equal(spec.command, '/data/tools/code-server/4.135.0/bin/code-server');
  assert.deepEqual(spec.args, [
    '--socket',
    '/data/editors/code-server/sock/7-a1b2c3-w.sock',
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
    listenSocketPath: '/data/editors/code-server/sock/7-a1b2c3-w.sock',
    sessionSocketPath: '/data/editors/code-server/sock/7-a1b2c3.sock',
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
    listenSocketPath: '/data/editors/code-server/sock/7-a1b2c3-w.sock',
    sessionSocketPath: '/data/editors/code-server/sock/7-a1b2c3.sock',
  });

  const flagValue = (flag: string) => spec.args[spec.args.indexOf(flag) + 1];
  assert.equal(flagValue('--auth'), 'none');
  assert.ok(spec.args.includes('--ignore-last-opened'));
  assert.ok(spec.args.includes('--disable-workspace-trust'));
});

test('Code Server listens on its listen socket and binds no TCP address', () => {
  const spec = editorLaunchSpec({
    installation: installation(),
    worktreePath: '/repo/isagi',
    listenSocketPath: '/s-w.sock',
    sessionSocketPath: '/s.sock',
  });

  const flagValue = (flag: string) => spec.args[spec.args.indexOf(flag) + 1];
  assert.equal(flagValue('--socket'), '/s-w.sock');
  assert.equal(flagValue('--session-socket'), '/s.sock');
  // Code Server ignores `--bind-addr` beside `--socket`; naming one anyway would
  // only suggest a TCP listener that does not exist.
  assert.equal(spec.args.includes('--bind-addr'), false);
});

test('the upstream origin is the upstream host over plain HTTP', () => {
  assert.equal(editorUpstreamHost, 'localhost');
  assert.equal(editorUpstreamOrigin, 'http://localhost');
});

test("an incarnation's two sockets share one token and are distinct paths", () => {
  const sockets = editorIncarnationSockets('/data/editors/code-server/sock', 7, 'a1b2c3');

  assert.deepEqual(sockets, {
    listenSocketPath: '/data/editors/code-server/sock/7-a1b2c3-w.sock',
    sessionSocketPath: editorSessionSocketPath('/data/editors/code-server/sock', 7, 'a1b2c3'),
  });
  assert.notEqual(sockets.listenSocketPath, sockets.sessionSocketPath);
  // The listen socket is the longer one, so it is the one the launch checks
  // against the cap.
  assert.ok(
    Buffer.byteLength(sockets.listenSocketPath) > Buffer.byteLength(sockets.sessionSocketPath),
  );
});

test('the socket paths are per incarnation, not per context', () => {
  const first = editorIncarnationSockets('/data/editors/code-server/sock', 7, 'a1b2c3');
  const second = editorIncarnationSockets('/data/editors/code-server/sock', 7, 'd4e5f6');

  assert.equal(first.sessionSocketPath, '/data/editors/code-server/sock/7-a1b2c3.sock');
  assert.notEqual(first.sessionSocketPath, second.sessionSocketPath);
  assert.notEqual(first.listenSocketPath, second.listenSocketPath);
});

test('a deep editors path produces a socket path over the byte cap', () => {
  const deep = `/Users/somebody/Library/Application Support/Isagi/${'nested/'.repeat(8)}editors/code-server/sock`;
  const { listenSocketPath: socketPath } = editorIncarnationSockets(deep, 1_234, 'a1b2c3');

  // The refusal itself lives in the launch sequence; what this pins is that a
  // realistic deep data directory genuinely crosses the cap, so that guard is
  // reachable rather than theoretical.
  assert.ok(Buffer.byteLength(socketPath) > maxSessionSocketPathBytes);
});
