import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { acquireWorktreeLock, releaseWorktreeLock } from './lock.mjs';

test('lock publishes complete metadata and blocks a live owner', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'isagi-lock-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = resolve(root, 'data/.isagi/dev-supervisor.lock');
  const lock = await acquireWorktreeLock({ lockPath, root, pid: 123, ownerAlive: () => 'live' });
  const owner = JSON.parse(await readFile(resolve(lockPath, 'owner.json'), 'utf8'));
  assert.deepEqual(owner, lock.metadata);
  await assert.rejects(
    acquireWorktreeLock({ lockPath, root, pid: 456, ownerAlive: () => 'live' }),
    /already running.*PID 123/,
  );
  assert.equal(await releaseWorktreeLock(lock), true);
});

test('stale recovery retries once and ownership token protects replacement lock', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'isagi-stale-lock-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = resolve(root, 'data/.isagi/dev-supervisor.lock');
  const oldLock = await acquireWorktreeLock({ lockPath, root, pid: 123 });
  const replacement = await acquireWorktreeLock({
    lockPath,
    root,
    pid: 456,
    ownerAlive: () => 'gone',
  });
  assert.equal(await releaseWorktreeLock(oldLock), false);
  assert.equal(await releaseWorktreeLock(replacement), true);
});

test('malformed lock metadata fails without guessing', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'isagi-malformed-lock-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = resolve(root, 'data/.isagi/dev-supervisor.lock');
  const lock = await acquireWorktreeLock({ lockPath, root });
  await writeFile(resolve(lockPath, 'owner.json'), '{}');
  await assert.rejects(acquireWorktreeLock({ lockPath, root }), /Remove it manually/);
  await rm(lock.path, { recursive: true });
});
