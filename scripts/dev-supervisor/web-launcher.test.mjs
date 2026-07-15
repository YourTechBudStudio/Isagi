import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';

import { createRecordDecoder, parseWebReadiness } from './protocol.mjs';

test('real Vite launcher falls back when its preferred loopback port is occupied', async () => {
  const root = resolve(import.meta.dirname, '../..');
  const blocker = createServer();
  await new Promise((resolvePromise, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolvePromise);
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
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const readiness = await waitForReadiness(child, () => stderr);
  assert.match(readiness.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.notEqual(Number(new URL(readiness.url).port), preferredPort);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.equal(child.exitCode, null);
  child.kill('SIGTERM');
  const result = await waitForExit(child);
  assert.deepEqual(result, { code: 143, signal: null });
  await new Promise((resolvePromise, reject) =>
    blocker.close((error) => (error ? reject(error) : resolvePromise())),
  );
});

function waitForReadiness(child, stderr) {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Vite readiness timeout: ${stderr()}`)),
      5_000,
    );
    const decoder = createRecordDecoder((record, ending) => {
      const parsed = parseWebReadiness(ending ? record.slice(0, -ending.length) : record);
      if (!parsed) return;
      clearTimeout(timeout);
      resolvePromise(parsed);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => decoder.write(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Vite exited before readiness: code=${code} signal=${signal} ${stderr()}`));
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise) =>
    child.once('exit', (code, signal) => resolvePromise({ code, signal })),
  );
}
