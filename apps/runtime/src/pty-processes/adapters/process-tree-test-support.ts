import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The leak the process-tree sweep exists for: an agent starts a helper in its
// own process group that ignores both the terminal hangup and SIGTERM.
// Signalling the PTY root alone leaves it running forever, re-parented to init.
//
// Run as `node -e leakyRootScript <pidFile>`: the root writes the helper's pid
// to `pidFile` and then idles until it is killed.
export const leakyRootScript = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});setInterval(()=>{},1000);"], { detached: true, stdio: 'ignore' });
writeFileSync(process.argv[1], String(child.pid));
setInterval(() => {}, 1000);
`;

// A scratch directory holding the helper's pid file. `cleanup` also SIGKILLs a
// helper a failing test left behind, so a red run does not leak what it tests.
export function leakyTreeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'isagi-process-tree-'));
  const pidFile = join(root, 'grandchild.pid');
  let helperPid: number | null = null;
  return {
    pidFile,
    waitForHelperPid: async () => {
      helperPid = await waitForPidFile(pidFile);
      return helperPid;
    },
    cleanup: () => {
      if (helperPid !== null) killQuietly(helperPid);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// The killed helper is re-parented to init, which reaps it asynchronously, so
// liveness is polled rather than checked once.
export async function waitUntilGone(pid: number) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return false;
}

async function waitForPidFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    }
    await sleep(50);
  }
  throw new Error('The leaky root never reported its detached helper.');
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killQuietly(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
