import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';

import { createRecordDecoder, parseWebReadiness } from './protocol.mjs';

const READINESS_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;

// Every resource this test opens (the port blocker, the Vite child and its pipes) is released in
// `t.after`, so a failed assertion or a crashed child ends as a clean failure. Without that, a
// leaked listening blocker keeps the test process alive and `pnpm check` hangs.
test(
  'real Vite launcher falls back when its preferred loopback port is occupied',
  { timeout: 60_000 },
  async (t) => {
    const root = resolve(import.meta.dirname, '../..');
    const blocker = createServer();
    t.after(() => closeServer(blocker));
    await new Promise((resolvePromise, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => resolvePromise(undefined));
    });
    const address = blocker.address();
    assert.ok(address && typeof address === 'object');
    const preferredPort = address.port;
    const child = spawn(
      process.execPath,
      ['scripts/vite-launcher.mjs', 'dev', '--', '--port', String(preferredPort)],
      {
        cwd: resolve(root, 'apps/web'),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    t.after(() => forceStop(child));
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const readiness = await waitForReadiness(child, () => stderr);
    assert.match(readiness.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.notEqual(Number(new URL(readiness.url).port), preferredPort);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    assert.equal(child.exitCode, null);
    child.kill('SIGTERM');
    const result = await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
    assert.ok(result, `Vite did not exit within ${SHUTDOWN_TIMEOUT_MS} ms of SIGTERM: ${stderr}`);
    // The launcher's contract is a graceful close followed by exit code 143. A signal-terminated
    // child never reached that exit, so it stays a failure; the message only names the cause.
    assert.deepEqual(result, { code: 143, signal: null }, describeUnexpectedExit(result, stderr));
  },
);

function waitForReadiness(child, stderr) {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Vite readiness timeout: ${stderr()}`)),
      READINESS_TIMEOUT_MS,
    );
    const decoder = createRecordDecoder((record, ending) => {
      const parsed = parseWebReadiness(ending ? record.slice(0, -ending.length) : record);
      if (!parsed) return;
      clearTimeout(timeout);
      resolvePromise(parsed);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => decoder.write(chunk));
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Vite exited before readiness: code=${code} signal=${signal} ${stderr()}`));
    });
  });
}

/** Resolves with the child's exit status, or `undefined` if it has not exited within `timeoutMs`. */
function waitForExit(child, timeoutMs) {
  if (hasExited(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise) => {
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolvePromise(undefined);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function forceStop(child) {
  if (child.pid !== undefined && !hasExited(child)) {
    child.kill('SIGKILL');
    await waitForExit(child, CLEANUP_TIMEOUT_MS);
  }
  // A surviving grandchild could still hold the pipes open; they must not keep this process alive.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function closeServer(server) {
  if (!server.listening) return undefined;
  return new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise(undefined))),
  );
}

function describeUnexpectedExit(result, stderr) {
  const nativeCrash =
    result.signal === 'SIGSEGV' || result.signal === 'SIGBUS'
      ? ' A SIGSEGV/SIGBUS here is a native crash inside the Vite child (observed with rolldown when SIGTERM cancels a cold dependency-optimizer run under parallel load), not a launcher exit path.'
      : '';
  return `Expected the launcher to close Vite and exit with code 143 after SIGTERM, got code=${result.code} signal=${result.signal}.${nativeCrash}\n${stderr}`;
}
