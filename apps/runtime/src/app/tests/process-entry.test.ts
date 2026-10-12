// The runtime process as the desktop host runs it: `src/index.ts` under `tsx`, against a temp data dir and a temp
// HOME, so the user's own `~/.isagi` is never touched. It owns process signals and `process.exit`, so it is
// exercised in a child process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUNTIME_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const READY_PREFIX = 'ISAGI_RUNTIME_READY ';

interface RuntimeProcessRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly url: string | undefined;
  readonly stdout: string;
  readonly stderr: string;
  /** Why `onReady` failed, if it did. */
  readonly readyError: unknown;
  readonly dataDir: string;
}

describe(
  'runtime process entry',
  { skip: process.platform === 'win32' ? 'POSIX signals' : false },
  () => {
    let scratch: string;

    before(() => {
      scratch = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-process-entry-')));
    });

    after(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    /** Starts the runtime; once it prints its ready line, `onReady` runs with the URL and `signal` is sent. */
    const runRuntime = (
      name: string,
      env: Readonly<Record<string, string>>,
      options: {
        readonly signal?: NodeJS.Signals;
        readonly onReady?: (url: string) => Promise<void>;
      } = {},
    ): Promise<RuntimeProcessRun> => {
      const home = join(scratch, name, 'home');
      const dataDir = join(scratch, name, 'data');
      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        ISAGI_DATA_DIR: dataDir,
        SHELL: '/bin/sh',
        ...env,
      };
      // Editor provisioning reports `not_applicable` without a capability, so nothing downloads.
      delete childEnv.ISAGI_EDITOR_CAPABILITY;
      delete childEnv.ISAGI_ALLOWED_ORIGINS;
      delete childEnv.ISAGI_RUNTIME_DEBUG;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
          cwd: RUNTIME_ROOT,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let url: string | undefined;
        let readyError: unknown;
        const deadline = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`${name}: the runtime did not exit in time; stderr:\n${stderr}`));
        }, 60_000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (url !== undefined) return;
          const line = stdout.split('\n').find((candidate) => candidate.startsWith(READY_PREFIX));
          if (line === undefined) return;
          url = (JSON.parse(line.slice(READY_PREFIX.length)) as { url: string }).url;
          const readyUrl = url;
          void (options.onReady?.(readyUrl) ?? Promise.resolve()).then(
            () => {
              if (options.signal) child.kill(options.signal);
            },
            (error: unknown) => {
              readyError = error;
              child.kill('SIGKILL');
            },
          );
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.once('error', reject);
        child.once('close', (code, signal) => {
          clearTimeout(deadline);
          resolve({ code, signal, url, stdout, stderr, readyError, dataDir });
        });
      });
    };

    test('SIGTERM path closes the server and exits 0', async () => {
      let healthStatus: number | undefined;
      const run = await runRuntime(
        'sigterm',
        {},
        {
          signal: 'SIGTERM',
          onReady: async (url) => {
            healthStatus = (await fetch(`${url}/api/v1/health`)).status;
          },
        },
      );

      assert.equal(run.readyError, undefined, String(run.readyError));
      assert.ok(run.url, `the runtime printed its ready line; stderr:\n${run.stderr}`);
      assert.equal(healthStatus, 200, 'the runtime served requests before the signal');
      assert.deepEqual([run.code, run.signal], [0, null], run.stderr);
      assert.doesNotMatch(run.stderr, /ISAGI_RUNTIME_STARTUP_FAILED|shutdown failed/);
      await assert.rejects(fetch(`${run.url}/api/v1/health`), 'the server no longer listens');
    });

    test('an invalid PORT is a startup failure line and exit 1', async () => {
      const run = await runRuntime('invalid-port', { PORT: 'x' });

      assert.equal(run.url, undefined);
      assert.deepEqual([run.code, run.signal], [1, null], run.stderr);
      assert.match(run.stderr, /^ISAGI_RUNTIME_STARTUP_FAILED\n/m);
      assert.match(run.stderr, /Invalid PORT value: x/);
      assert.equal(
        existsSync(run.dataDir),
        false,
        'nothing was built before the settings were read',
      );
    });
  },
);
