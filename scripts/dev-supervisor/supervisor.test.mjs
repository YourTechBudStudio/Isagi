import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

import {
  createDesktopEnvironment,
  createSupervisorSignalSource,
  createWebEnvironment,
  runDevelopmentSupervisor,
  superviseChildren,
  terminateChild,
} from './supervisor.mjs';

const fixture = fileURLToPath(new URL('./fixture-child.mjs', import.meta.url));
const signalFixture = fileURLToPath(new URL('./signal-fixture.mjs', import.meta.url));

test('root supervision forces managed desktop ownership without dropping host tooling', () => {
  assert.deepEqual(
    createDesktopEnvironment(
      {
        PATH: '/usr/bin',
        SSH_AUTH_SOCK: '/tmp/agent',
        ELECTRON_RUN_AS_NODE: '1',
        ISAGI_RUNTIME_URL: 'http://remote.invalid',
        VITE_ISAGI_RUNTIME_URL: 'http://stale.invalid',
        ISAGI_WEB_URL: 'http://stale.invalid',
      },
      '/checkout',
    ),
    {
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: '/tmp/agent',
      ISAGI_DEV_WORKTREE_ROOT: '/checkout',
      ISAGI_DEV_PROCESS_OWNER: '1',
      ISAGI_DESKTOP_LOG_MODE: 'supervisor',
      ISAGI_RUNTIME_DEBUG: '1',
    },
  );
});

test('root supervision removes a stale renderer runtime URL from Vite', () => {
  assert.deepEqual(
    createWebEnvironment({ PATH: '/usr/bin', VITE_ISAGI_RUNTIME_URL: 'http://stale.invalid' }),
    { PATH: '/usr/bin' },
  );
});

test('root supervision owns the prepared stack and releases its worktree lock', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-supervisor-root-'));
  for (const path of [
    'package.json',
    'pnpm-workspace.yaml',
    'apps/desktop/package.json',
    'apps/web/package.json',
  ]) {
    mkdirSync(resolve(root, path, '..'), { recursive: true });
    writeFileSync(resolve(root, path), '{}');
  }
  let acquisition = 0;
  try {
    const code = await Effect.runPromise(
      runDevelopmentSupervisor({
        root,
        electronExecutable: process.execPath,
        presenter: () => {},
        spawnChild: (_command, _args, options) =>
          spawn(
            process.execPath,
            [fixture, acquisition++ === 0 ? 'web-ready' : 'desktop-success'],
            options,
          ),
      }),
    );

    assert.equal(code, 0);
    assert.equal(existsSync(resolve(root, 'data/.isagi/dev-supervisor.lock')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('root supervision preserves an explicit runtime diagnostic setting', () => {
  assert.equal(
    createDesktopEnvironment({ ISAGI_RUNTIME_DEBUG: '0' }, '/checkout').ISAGI_RUNTIME_DEBUG,
    '0',
  );
});

test('supervisor signal source latches the first cause across phase subscriptions', () => {
  const signalProcess = new EventEmitter();
  const source = createSupervisorSignalSource(signalProcess);
  const observed = [];
  source.subscribe((signal) => observed.push(signal));
  signalProcess.emit('SIGTERM');
  signalProcess.emit('SIGINT');
  source.subscribe((signal) => observed.push(signal));
  source.dispose();

  assert.deepEqual(observed, [
    { signal: 'SIGTERM', exitCode: 143 },
    { signal: 'SIGTERM', exitCode: 143 },
  ]);
  assert.equal(signalProcess.listenerCount('SIGINT'), 0);
  assert.equal(signalProcess.listenerCount('SIGTERM'), 0);
});

test('fixture stack waits for web readiness and returns normal desktop exit', async () => {
  const events = [];
  let acquisition = 0;
  const code = await Effect.runPromise(
    superviseChildren({
      root: process.cwd(),
      electronExecutable: process.execPath,
      readinessTimeoutMs: 500,
      presenter: (event) => events.push(event),
      spawnChild: (_command, _args, options) =>
        spawn(
          process.execPath,
          [fixture, acquisition++ === 0 ? 'web-ready' : 'desktop-success'],
          options,
        ),
    }),
  );
  assert.equal(code, 0);
  assert.ok(events.some((event) => event.source === 'web' && event.payload.includes('ready at')));
  assert.ok(
    events.some((event) => event.source === 'desktop' && event.payload === 'desktop partial'),
  );
});

test('supervisor drains inherited child output before reporting completion', async () => {
  const events = [];
  let acquisition = 0;
  const code = await Effect.runPromise(
    superviseChildren({
      root: process.cwd(),
      electronExecutable: process.execPath,
      readinessTimeoutMs: 500,
      presenter: (event) => events.push(event),
      spawnChild: (_command, _args, options) =>
        spawn(
          process.execPath,
          [fixture, acquisition++ === 0 ? 'web-ready' : 'desktop-late-output'],
          options,
        ),
    }),
  );

  assert.equal(code, 0);
  assert.ok(events.some((event) => event.payload === 'desktop final\n'));
});

test('supervisor bounds output drain so the outer owner can remove a residual tree', async () => {
  const events = [];
  let acquisition = 0;
  const code = await Effect.runPromise(
    superviseChildren({
      root: process.cwd(),
      electronExecutable: process.execPath,
      readinessTimeoutMs: 500,
      outputDrainGraceMs: 20,
      presenter: (event) => events.push(event),
      spawnChild: (_command, _args, options) =>
        spawn(
          process.execPath,
          [fixture, acquisition++ === 0 ? 'web-ready' : 'desktop-held-output'],
          options,
        ),
    }),
  );

  assert.equal(code, 0);
  assert.ok(events.some((event) => event.payload.includes('escalating residual cleanup')));
});

test('fixture stack preserves managed runtime failure and nested runtime stream', async () => {
  const events = [];
  let acquisition = 0;
  const code = await Effect.runPromise(
    superviseChildren({
      root: process.cwd(),
      electronExecutable: process.execPath,
      readinessTimeoutMs: 500,
      presenter: (event) => events.push(event),
      spawnChild: (_command, _args, options) =>
        spawn(
          process.execPath,
          [fixture, acquisition++ === 0 ? 'web-ready' : 'desktop-runtime-failure'],
          options,
        ),
    }),
  );
  assert.equal(code, 7);
  assert.ok(
    events.some(
      (event) =>
        event.source === 'runtime' &&
        event.stream === 'stderr' &&
        event.payload === 'runtime failed\n',
    ),
  );
});

test('fixture stack rejects malformed readiness and cleans up web', async () => {
  const events = [];
  const code = await Effect.runPromise(
    superviseChildren({
      root: process.cwd(),
      electronExecutable: process.execPath,
      readinessTimeoutMs: 500,
      presenter: (event) => events.push(event),
      spawnChild: (_command, _args, options) =>
        spawn(process.execPath, [fixture, 'web-malformed'], options),
    }),
  );
  assert.equal(code, 1);
  assert.ok(events.some((event) => event.payload.includes('malformed JSON')));
});

for (const [mode, expectedCode, expectedMessage] of [
  ['web-duplicate', 1, 'duplicate readiness'],
  ['web-silent', 1, 'Timed out waiting'],
  ['web-failure', 4, 'before readiness'],
  ['web-success', 1, 'before readiness'],
  ['web-ready-exit', 1, 'Web exited while Electron was active'],
]) {
  test(`fixture stack handles ${mode}`, async () => {
    const events = [];
    let acquisition = 0;
    const code = await Effect.runPromise(
      superviseChildren({
        root: process.cwd(),
        electronExecutable: process.execPath,
        readinessTimeoutMs: 50,
        presenter: (event) => events.push(event),
        spawnChild: (_command, _args, options) =>
          spawn(process.execPath, [fixture, acquisition++ === 0 ? mode : 'desktop-wait'], options),
      }),
    );
    assert.equal(code, expectedCode);
    if (expectedMessage) {
      assert.ok(events.some((event) => event.payload.includes(expectedMessage)));
    }
  });
}

test('termination escalates a resistant fixture without leaving it running', async () => {
  const child = spawn(process.execPath, [fixture, 'resist-term'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  await terminateChild(child, 50);
  assert.notEqual(child.signalCode, null);
});

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(`supervisor ${signal} tears down the fixture tree and returns ${exitCode}`, async () => {
    const child = spawn(process.execPath, [signalFixture], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childPids = await new Promise((resolvePromise, reject) => {
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const match = stdout.match(/READY (\d+) (\d+)\n/);
        if (match) resolvePromise(match.slice(1).map(Number));
      });
      child.once('error', reject);
    });
    child.kill(signal);
    const result = await new Promise((resolvePromise) =>
      child.once('exit', (code, observedSignal) =>
        resolvePromise({ code, signal: observedSignal }),
      ),
    );
    assert.deepEqual(result, { code: exitCode, signal: null });
    for (const pid of childPids) await assertProcessStops(pid);
  });
}

async function assertProcessStops(pid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.fail(`supervised child ${pid} remained alive`);
}
