import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Where the shim for one runtime version lives: `<toolsPath>/isagi-cli/<version>/bin/isagi`.
 *
 * Versioned like every other tool under `toolsPath`, and under the data root, so a development
 * runtime and an installed one never overwrite each other's shim.
 */
export function cliShimPath(toolsPath: string, runtimePackageVersion: string): string {
  return join(toolsPath, 'isagi-cli', runtimePackageVersion, 'bin', 'isagi');
}

/**
 * The POSIX `sh` launcher for the bundled CLI. It runs the bundle with the runtime's own executable
 * — Electron in an installed app, Node in development — so `ELECTRON_RUN_AS_NODE=1` makes Electron
 * behave as Node and is harmless for Node.
 */
export function renderCliShim(input: {
  readonly execPath: string;
  readonly entryPath: string;
}): string {
  return [
    '#!/bin/sh',
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(input.execPath)} ${shellQuote(input.entryPath)} "$@"`,
    '',
  ].join('\n');
}

/**
 * Writes the shim atomically: a sibling temp file with mode `0o755`, renamed into place, so a
 * terminal running `isagi` while the runtime starts sees the old shim or the new one, never half of
 * one.
 */
export async function writeCliShim(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, content, { mode: 0o755 });
    // The creation mode is filtered by the umask; the shim must be executable regardless.
    await chmod(temporary, 0o755);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
