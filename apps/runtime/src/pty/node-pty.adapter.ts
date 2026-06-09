import { accessSync, chmodSync, constants, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { Context, Effect, Layer } from 'effect';
import * as nodePty from 'node-pty';

import type { PtyAdapter as PtyAdapterShape, PtyHandle } from './types.js';
import { PtyKillError, PtyResizeError, PtyStartError, PtyWriteError } from './types.js';

interface NodePtyHandle extends PtyHandle {
  readonly process: nodePty.IPty;
}

export const PtyAdapter = Context.GenericTag<PtyAdapterShape>('isagi/PtyAdapter');

export const NodePtyAdapterLive = Layer.effect(
  PtyAdapter,
  Effect.sync(() => {
    ensureNodePtyDarwinHelperExecutable();

    return {
      name: 'node_pty',
      start: (input) =>
        Effect.try({
          try: () => {
            const pty = nodePty.spawn(input.command, [], {
              name: 'xterm-256color',
              cols: input.cols,
              rows: input.rows,
              cwd: input.cwd,
              env: input.env,
            });
            pty.onData(input.onOutput);
            pty.onExit((event) =>
              input.onExit({
                exitCode: event.exitCode ?? null,
                signal: event.signal ? String(event.signal) : null,
              }),
            );
            return { pid: pty.pid, process: pty } satisfies NodePtyHandle;
          },
          catch: (cause) => new PtyStartError({ command: input.command, cwd: input.cwd, cause }),
        }),
      write: (handle, data) =>
        Effect.try({
          try: () => (handle as NodePtyHandle).process.write(data),
          catch: (cause) => new PtyWriteError({ cause }),
        }),
      resize: (handle, size) =>
        Effect.try({
          try: () => (handle as NodePtyHandle).process.resize(size.cols, size.rows),
          catch: (cause) => new PtyResizeError({ cause }),
        }),
      kill: (handle) =>
        Effect.try({
          try: () => (handle as NodePtyHandle).process.kill(),
          catch: (cause) => new PtyKillError({ cause }),
        }),
    } satisfies PtyAdapterShape;
  }),
);

function ensureNodePtyDarwinHelperExecutable() {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    const helper = findNodePtySpawnHelper();
    if (!helper) {
      return;
    }

    try {
      accessSync(helper, constants.X_OK);
      return;
    } catch {
      const mode = statSync(helper).mode;
      chmodSync(helper, mode | 0o111);
      console.warn(`[runtime] Repaired node-pty macOS spawn helper permissions: ${helper}`);
    }
  } catch (error) {
    console.warn(
      '[runtime] Could not inspect or repair node-pty macOS spawn helper permissions',
      error,
    );
  }
}

function findNodePtySpawnHelper() {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve('node-pty/package.json');
  const packageRoot = dirname(packageJson);
  const candidates = [
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
    join(packageRoot, 'build', 'Debug', 'spawn-helper'),
  ];

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep looking; package layouts vary by install method.
    }
  }

  return findFileByName(packageRoot, 'spawn-helper', 4);
}

function findFileByName(root: string, name: string, maxDepth: number): string | null {
  if (maxDepth < 0) {
    return null;
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) {
      return path;
    }
    if (entry.isDirectory()) {
      const found = findFileByName(path, name, maxDepth - 1);
      if (found) {
        return found;
      }
    }
  }

  return null;
}
