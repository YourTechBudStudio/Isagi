// Launches the unpackaged desktop app for one test: a fresh data directory (and so a fresh Electron profile beside
// it), an optional `config.yaml`, and an environment with nothing from the developer's own Isagi setup.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = createRequire(join(desktopRoot, 'package.json'))('electron') as string;

/** Environment keys that would steer the app or its runtime away from the test's own data directory. */
const scrubbed = [
  'ISAGI_WEB_URL',
  'ISAGI_DATA_DIR',
  'ISAGI_HOST',
  'ISAGI_PORT',
  'ISAGI_ALLOWED_ORIGINS',
  'ISAGI_DEV_WORKTREE_ROOT',
  'ISAGI_DEV_PROCESS_OWNER',
  'ISAGI_DESKTOP_LOG_MODE',
  'ISAGI_DEV_RUNTIME_URL',
  'ISAGI_DEV_DATA_DIR',
  'ISAGI_LAUNCHER_TOKEN',
  'ELECTRON_RUN_AS_NODE',
];

export interface LaunchedDesktop {
  readonly app: ElectronApplication;
  readonly window: Page;
  readonly dataDirectory: string;
  /** Everything the main process (and the runtime through it) printed so far. */
  readonly output: () => string;
  readonly close: () => Promise<void>;
}

export async function launchDesktop(
  options: { readonly config?: string } = {},
): Promise<LaunchedDesktop> {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'isagi-desktop-e2e-'));
  if (options.config !== undefined)
    writeFileSync(join(dataDirectory, 'config.yaml'), options.config);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !scrubbed.includes(key)) env[key] = value;
  }
  env.ISAGI_DATA_DIR = dataDirectory;
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopRoot],
    cwd: desktopRoot,
    env,
  });
  let output = '';
  app.process().stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  app.process().stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const window = await app.firstWindow();
  let closed = false;
  return {
    app,
    window,
    dataDirectory,
    output: () => output,
    close: async () => {
      if (!closed) {
        closed = true;
        await app.close().catch(() => undefined);
      }
      rmSync(dataDirectory, { recursive: true, force: true });
    },
  };
}

/** The window's background colour, as the main process set it before anything painted. */
export function windowBackground(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getBackgroundColor(),
  );
}

/** The page's URL in the main frame, read from the main process (no page round-trip). */
export function windowUrl(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.getURL(),
  );
}

/** Holds a loopback port so a runtime configured for it cannot bind. */
export async function occupyPort(): Promise<{
  readonly port: number;
  readonly release: () => Promise<void>;
}> {
  const server: Server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('no port');
  return {
    port: address.port,
    release: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

/** The managed runtime's pid: the process serving this test's own data directory. */
export function runtimePid(dataDirectory: string): number {
  const listing = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  const line = listing
    .split('\n')
    .find((entry) => entry.includes('isagi.mjs serve') && entry.includes(dataDirectory));
  if (!line) throw new Error(`no runtime process for ${dataDirectory}`);
  return Number(line.trim().split(/\s+/u)[0]);
}

/** The canvas colours the build generated from the web stylesheet. */
export const canvas = { dark: '#24273A', light: '#E6E9EF' } as const;
