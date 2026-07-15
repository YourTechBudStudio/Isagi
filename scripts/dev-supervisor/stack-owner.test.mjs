import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ownedTreeTerminationPlan, runStackOwner, waitForOwnedTreeExit } from './stack-owner.mjs';

const controllerFixture = fileURLToPath(new URL('./owner-controller-fixture.mjs', import.meta.url));
const ownerFixture = fileURLToPath(new URL('./owner-runner-fixture.mjs', import.meta.url));

class FakeController extends EventEmitter {
  pid = 4321;
  exitCode = null;
  signalCode = null;
  signals = [];
  stdin = { destroy() {} };

  kill(signal) {
    this.signals.push(signal);
  }
}

test('second interrupt bypasses the graceful timeout and preserves exit code 130', async () => {
  const signalProcess = new EventEmitter();
  const controller = new FakeController();
  const treeTerminations = [];
  const owner = runStackOwner({
    command: 'controller',
    args: [],
    cwd: process.cwd(),
    signalProcess,
    spawnChild: () => controller,
    terminateOwnedTree: (...args) => treeTerminations.push(args),
  });

  signalProcess.emit('SIGINT');
  assert.deepEqual(controller.signals, ['SIGINT']);
  assert.equal(treeTerminations.length, 0);
  signalProcess.emit('SIGINT');
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(treeTerminations.length, 1);
  controller.emit('exit', null, 'SIGKILL');
  assert.equal(await owner, 130);
});

test('graceful timeout escalates through the outer ownership adapter', async () => {
  const signalProcess = new EventEmitter();
  const controller = new FakeController();
  let treeTerminations = 0;
  const owner = runStackOwner({
    command: 'controller',
    args: [],
    cwd: process.cwd(),
    signalProcess,
    shutdownGraceMs: 5,
    spawnChild: () => controller,
    terminateOwnedTree: () => {
      treeTerminations += 1;
    },
  });

  signalProcess.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(treeTerminations, 1);
  controller.emit('exit', null, 'SIGKILL');
  assert.equal(await owner, 143);
});

test('stack owner does not resolve until owned-tree termination is confirmed', async () => {
  const signalProcess = new EventEmitter();
  const controller = new FakeController();
  let confirmTermination;
  let resolved = false;
  const owner = runStackOwner({
    command: 'controller',
    args: [],
    cwd: process.cwd(),
    signalProcess,
    spawnChild: () => controller,
    terminateOwnedTree: () =>
      new Promise((resolvePromise) => {
        confirmTermination = resolvePromise;
      }),
  });
  void owner.then(() => {
    resolved = true;
  });

  controller.emit('exit', 0, null);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(resolved, false);
  confirmTermination();
  assert.equal(await owner, 0);
  assert.equal(resolved, true);
});

test('tree termination plans use one POSIX group or registered Windows PID trees', () => {
  assert.deepEqual(ownedTreeTerminationPlan(42, new Set([43, 44]), 'darwin'), {
    kind: 'posix-process-group',
    processGroupPid: -42,
  });
  assert.deepEqual(ownedTreeTerminationPlan(42, new Set([43, 44]), 'win32'), {
    kind: 'windows-pid-trees',
    taskkillArguments: [
      ['/PID', '42', '/T', '/F'],
      ['/PID', '43', '/T', '/F'],
      ['/PID', '44', '/T', '/F'],
    ],
  });
});

test('owned-tree exit polling returns surviving process IDs at its deadline', async () => {
  let time = 0;
  let polls = 0;
  const survivors = await waitForOwnedTreeExit(
    { kind: 'posix-process-group', processGroupPid: -42 },
    {
      timeoutMs: 30,
      now: () => time,
      poll: () => {
        polls += 1;
        time += 10;
      },
      aliveProcessIds: () => [-42],
    },
  );

  assert.deepEqual(survivors, [-42]);
  assert.equal(polls, 3);
});

test(
  'stack owner kills the inherited process group when its controller dies',
  { skip: process.platform === 'win32' },
  async () => {
    let controller;
    const owner = runStackOwner({
      command: process.execPath,
      args: [controllerFixture],
      cwd: process.cwd(),
      spawnChild: (command, args, options) => {
        controller = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
        return controller;
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const [, childPid] = await waitForOwnerReady(controller);
    controller.kill('SIGKILL');
    assert.equal(await owner, 137);
    await assertProcessStops(childPid);
  },
);

test(
  'controller shuts down its descendants when the outer owner disappears',
  { skip: process.platform === 'win32' },
  async () => {
    const owner = spawn(process.execPath, [ownerFixture], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const [controllerPid, childPid] = await waitForOwnerReady(owner);
    owner.kill('SIGKILL');
    await waitForExit(owner);
    await assertProcessStops(controllerPid);
    await assertProcessStops(childPid);
  },
);

function waitForOwnerReady(child) {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error('Owner fixture readiness timeout.')), 2_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/OWNER_READY (\d+) (\d+)\n/);
      if (!match) return;
      clearTimeout(timeout);
      resolvePromise(match.slice(1).map(Number));
    });
    child.once('error', reject);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => child.once('exit', resolvePromise));
}

async function assertProcessStops(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.fail(`owned process ${pid} remained alive`);
}
