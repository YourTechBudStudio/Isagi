// The runtime process as every launcher starts it: `isagi serve`, here from source (`scripts/serve-from-source.ts`
// under `tsx`), against a temp data dir and a temp HOME, so the user's own `~/.isagi` is never touched. It owns
// process signals and `process.exit`, so it is exercised in a child process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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

    /**
     * Runs `serve --data-dir <scratch>/<name>/data <args>`; once it prints its ready line, `onReady` runs with the URL
     * and `signal` is sent. `config` is written to the data directory's `config.yaml` first.
     */
    const runRuntime = (
      name: string,
      env: Readonly<Record<string, string>>,
      options: {
        readonly args?: readonly string[];
        readonly config?: string;
        readonly signal?: NodeJS.Signals;
        readonly onReady?: (url: string) => Promise<void>;
      } = {},
    ): Promise<RuntimeProcessRun> => {
      const home = join(scratch, name, 'home');
      const dataDir = join(scratch, name, 'data');
      if (options.config !== undefined) {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, 'config.yaml'), options.config, 'utf8');
      }
      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        SHELL: '/bin/sh',
      };
      // Every runtime starts provisioning Code Server after readiness; the SIGTERM that ends a case which reached
      // readiness interrupts that attempt and cleans up its staging directory.
      for (const key of ['ISAGI_DATA_DIR', 'ISAGI_HOST', 'ISAGI_PORT', 'ISAGI_RUNTIME_DEBUG']) {
        delete childEnv[key];
      }
      Object.assign(childEnv, env);
      const args = ['--data-dir', dataDir, ...(options.args ?? [])];
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'scripts/serve-from-source.ts', ...args],
          {
            cwd: RUNTIME_ROOT,
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
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

    /** Starts the runtime, reads the port it bound from its ready line, then stops it with SIGTERM. */
    const boundPort = async (
      name: string,
      env: Readonly<Record<string, string>>,
      options: { readonly args?: readonly string[]; readonly config?: string } = {},
    ) => {
      const run = await runRuntime(name, env, { ...options, signal: 'SIGTERM' });
      assert.ok(run.url, `the runtime printed its ready line; stderr:\n${run.stderr}`);
      assert.deepEqual([run.code, run.signal], [0, null], run.stderr);
      return Number(new URL(run.url).port);
    };

    test('ISAGI_PORT binds that port', async () => {
      const port = await freePort();
      assert.equal(await boundPort('env-port', { ISAGI_PORT: String(port) }), port);
    });

    test('config.yaml server.port binds that port', async () => {
      const port = await freePort();
      assert.equal(
        await boundPort('config-port', {}, { config: `server:\n  port: ${port}\n` }),
        port,
      );
    });

    test('--port beats ISAGI_PORT', async () => {
      const flagPort = await freePort();
      const envPort = await freePort(flagPort);
      assert.equal(
        await boundPort(
          'flag-port',
          { ISAGI_PORT: String(envPort) },
          { args: ['--port', String(flagPort)] },
        ),
        flagPort,
      );
    });

    test('ISAGI_HOST=0.0.0.0 reports a loopback URL', async () => {
      const run = await runRuntime(
        'wildcard-host',
        { ISAGI_HOST: '0.0.0.0' },
        { signal: 'SIGTERM' },
      );
      assert.ok(run.url, `the runtime printed its ready line; stderr:\n${run.stderr}`);
      assert.match(run.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.deepEqual([run.code, run.signal], [0, null], run.stderr);
    });

    test('an invalid ISAGI_PORT is a usage error, exit 2, before anything is built', async () => {
      const run = await runRuntime('invalid-port', { ISAGI_PORT: '80a' });

      assert.equal(run.url, undefined);
      assert.deepEqual([run.code, run.signal], [2, null], run.stderr);
      assert.match(run.stderr, /^isagi: cli_usage_invalid: ISAGI_PORT must be a whole number/m);
      assert.doesNotMatch(run.stderr, /ISAGI_RUNTIME_STARTUP_FAILED/);
      assert.equal(
        existsSync(run.dataDir),
        false,
        'nothing was built before the settings were checked',
      );
    });

    test('a port already in use is a startup failure naming the port and its source', async () => {
      const blocker = createServer();
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      const port = (blocker.address() as { port: number }).port;
      try {
        const run = await runRuntime('port-in-use', {}, { config: `server:\n  port: ${port}\n` });

        assert.equal(run.url, undefined);
        assert.deepEqual([run.code, run.signal], [1, null], run.stderr);
        assert.match(run.stderr, /^ISAGI_RUNTIME_STARTUP_FAILED\n/m);
        assert.ok(
          run.stderr.includes(
            `Could not listen on 127.0.0.1:${port} (host from default, port from config.yaml server.port)`,
          ),
          run.stderr,
        );
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });
  },
);

/**
 * A port the OS reports free right now, other than `except`. Another process could take it before the runtime binds
 * it; that window is accepted here.
 */
async function freePort(except?: number): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (port !== except) return port;
  }
}
