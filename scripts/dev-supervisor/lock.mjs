import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function acquireWorktreeLock({
  lockPath,
  root,
  pid = process.pid,
  ownerAlive = isOwnerAlive,
}) {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const metadata = { pid, root, acquiredAt: new Date().toISOString(), token };
  let retried = false;

  for (;;) {
    const candidate = `${lockPath}.candidate-${token}`;
    await mkdir(candidate);
    try {
      await writeFile(`${candidate}/owner.json`, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    } catch (error) {
      await rm(candidate, { recursive: true, force: true });
      throw error;
    }
    try {
      await rename(candidate, lockPath);
      return { path: lockPath, token, metadata };
    } catch (error) {
      await rm(candidate, { recursive: true, force: true });
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
    }

    const owner = await readOwner(lockPath);
    if (!owner) {
      throw new Error(
        `Development lock metadata is missing or malformed at ${lockPath}. Remove it manually after verifying no Isagi development stack is running.`,
      );
    }
    const status = ownerAlive(owner.pid);
    if (status === 'live') {
      throw new Error(
        `Isagi development is already running for ${root} (PID ${owner.pid}, lock ${lockPath}).`,
      );
    }
    if (status !== 'gone' || retried) {
      throw new Error(`Could not safely recover stale development lock at ${lockPath}.`);
    }
    const removed = await releaseWorktreeLock({ path: lockPath, token: owner.token });
    if (!removed)
      throw new Error(`Development lock ownership changed during stale recovery at ${lockPath}.`);
    retried = true;
  }
}

export async function releaseWorktreeLock(lock) {
  const owner = await readOwner(lock.path);
  if (owner?.token !== lock.token) return false;
  // The directory protocol cannot atomically compare owner.json and remove its
  // parent. A replacement lock may win this narrow read/remove race; callers
  // tolerate it because this lock only coordinates local development startup.
  await rm(lock.path, { recursive: true });
  return true;
}

async function readOwner(lockPath) {
  try {
    const value = JSON.parse(await readFile(`${lockPath}/owner.json`, 'utf8'));
    if (
      !Number.isInteger(value?.pid) ||
      value.pid <= 0 ||
      typeof value.root !== 'string' ||
      typeof value.acquiredAt !== 'string' ||
      typeof value.token !== 'string'
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function isOwnerAlive(pid) {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    if (error?.code === 'EPERM') return 'live';
    if (error?.code === 'ESRCH') return 'gone';
    return 'unknown';
  }
}
