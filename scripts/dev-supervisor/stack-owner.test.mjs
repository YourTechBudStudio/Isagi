import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runStackOwner } from './stack-owner.mjs';

const controllerFixture = fileURLToPath(new URL('./owner-controller-fixture.mjs', import.meta.url));
const ownerFixture = fileURLToPath(new URL('./owner-runner-fixture.mjs', import.meta.url));

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
