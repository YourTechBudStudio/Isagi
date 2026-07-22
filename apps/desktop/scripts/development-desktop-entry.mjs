import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Data, Effect, Exit } from 'effect';

const DEVELOPMENT_ENTRY_MARKER = 'X-Isagi-DevelopmentLauncher=';
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '../..');

class DevelopmentDesktopEntryError extends Data.TaggedError('DevelopmentDesktopEntryError') {}

export function developmentDesktopEntryPath(dataHome, desktopName) {
  return join(dataHome, 'applications', desktopName);
}

export function renderDevelopmentDesktopEntry(options) {
  const applicationId = options.desktopName.replace(/\.desktop$/, '');
  return [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    'Name=Isagi',
    'Comment=Launch the complete Isagi development stack for this worktree.',
    `Exec=${desktopExecArgument(options.nodeExecutable)} ${desktopExecArgument(options.pnpmExecutable)} --dir ${desktopExecArgument(options.repositoryRoot)} dev`,
    `Path=${desktopValue(options.repositoryRoot)}`,
    `Icon=${desktopValue(options.iconPath)}`,
    'Terminal=true',
    'Categories=Development;',
    `StartupWMClass=${desktopValue(applicationId)}`,
    `${DEVELOPMENT_ENTRY_MARKER}${desktopValue(options.repositoryRoot)}`,
    '',
  ].join('\n');
}

export function manageDevelopmentDesktopEntry(action, options) {
  return Effect.gen(function* () {
    if (options.platform !== 'linux') {
      return yield* fail(
        `Development desktop launcher integration is Linux-only, not ${options.platform}.`,
      );
    }
    if (action !== 'install' && action !== 'uninstall') {
      return yield* fail(
        `Expected desktop launcher action "install" or "uninstall", received ${String(action)}.`,
      );
    }

    const entryPath = developmentDesktopEntryPath(options.dataHome, options.desktopName);
    const existing = yield* tryOperation(entryPath, () => readOptionalFile(entryPath));
    if (existing !== undefined && !existing.includes(DEVELOPMENT_ENTRY_MARKER)) {
      return yield* fail(
        `Refusing to replace ${entryPath} because it is not an Isagi development launcher. Remove or relocate the existing production launcher first.`,
      );
    }

    if (action === 'uninstall') {
      if (existing !== undefined) {
        yield* tryOperation(entryPath, () => rm(entryPath));
      }
      return { action, changed: existing !== undefined, entryPath };
    }

    const contents = renderDevelopmentDesktopEntry(options);
    yield* tryOperation(dirname(entryPath), () => mkdir(dirname(entryPath), { recursive: true }));
    yield* tryOperation(entryPath, () =>
      writeFile(entryPath, contents, { encoding: 'utf8', mode: 0o644 }),
    );
    return { action, changed: existing !== contents, entryPath };
  });
}

function desktopExecArgument(value) {
  return `"${desktopValue(value).replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('"', '\\"')}"`;
}

function desktopValue(value) {
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new DevelopmentDesktopEntryError({
      message: 'Desktop entry values cannot contain line breaks or null bytes.',
    });
  }
  return value.replaceAll('\\', '\\\\');
}

function tryOperation(path, operation) {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new DevelopmentDesktopEntryError({
        message: `Desktop launcher operation failed at ${path}.`,
        cause,
      }),
  });
}

function fail(reason) {
  return Effect.fail(new DevelopmentDesktopEntryError({ message: reason }));
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function runCli() {
  const packageManifest = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8'));
  const desktopName = packageManifest.desktopName;
  if (typeof desktopName !== 'string' || !desktopName.endsWith('.desktop')) {
    throw new DevelopmentDesktopEntryError({
      message: 'Desktop package metadata must declare a .desktop filename in desktopName.',
    });
  }
  const pnpmExecutable = process.env.npm_execpath;
  if (!pnpmExecutable) {
    throw new DevelopmentDesktopEntryError({
      message: 'Run this command through pnpm so the launcher can capture its executable path.',
    });
  }
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const exit = await Effect.runPromiseExit(
    manageDevelopmentDesktopEntry(process.argv[2], {
      dataHome,
      desktopName,
      iconPath: resolve(desktopRoot, 'assets/app-icon-linux.png'),
      nodeExecutable: process.execPath,
      platform: process.platform,
      pnpmExecutable,
      repositoryRoot,
    }),
  );
  if (Exit.isFailure(exit)) {
    console.error(Cause.pretty(exit.cause, { renderErrorCause: true }));
    process.exitCode = 1;
    return;
  }
  const result = exit.value;
  const verb = result.action === 'install' ? 'installed' : 'removed';
  const qualifier = result.changed ? verb : `already ${verb}`;
  console.log(`[desktop] Development launcher ${qualifier}: ${result.entryPath}`);
  if (result.action === 'install') {
    console.log('[desktop] Restart pnpm dev so GNOME can associate the window with this launcher.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
