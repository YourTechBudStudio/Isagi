import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';

import { Data, Effect } from 'effect';

import { developmentEnvironmentKeys, developmentProtocolVersion } from './dev-protocol.mjs';
import { acquireWorktreeLock, releaseWorktreeLock } from './lock.mjs';
import {
  developmentPaths,
  exitCodeForResult,
  isLoopbackUrl,
  resolveRepositoryRoot,
} from './policy.mjs';
import {
  createLogPresenter,
  createRecordDecoder,
  parseRuntimeLog,
  parseWebReadiness,
} from './protocol.mjs';

export class SupervisorFailure extends Data.TaggedError('SupervisorFailure') {}

export function runDevelopmentSupervisor(options = {}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const root =
        options.root ?? (yield* Effect.promise(() => resolveRepositoryRoot(import.meta.url)));
      yield* Effect.promise(() => validateRepositoryRoot(root));
      const paths = developmentPaths(root);
      const presenter =
        options.presenter ??
        createLogPresenter({
          stdout: process.stdout,
          stderr: process.stderr,
          color: Boolean(
            process.stdout.isTTY && process.stderr.isTTY && !('NO_COLOR' in process.env),
          ),
        });
      const lock = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => acquireWorktreeLock({ lockPath: paths.lock, root }),
          catch: (cause) => failure(errorMessage(cause)),
        }),
        (owner) => Effect.promise(() => releaseWorktreeLock(owner)),
      );
      const electronExecutable =
        options.electronExecutable ?? resolveElectronExecutable(paths.desktopRoot);
      const signals = yield* Effect.acquireRelease(
        Effect.sync(() => createSupervisorSignalSource()),
        (source) => Effect.sync(() => source.dispose()),
      );

      presenter({ source: 'dev', stream: 'stdout', payload: `worktree ${root}\n` });
      presenter({ source: 'dev', stream: 'stdout', payload: `lock ${lock.path}\n` });

      if (signals.selected) return signals.selected.exitCode;
      return yield* superviseChildren({
        root,
        paths,
        presenter,
        signals,
        ...options,
        electronExecutable,
      });
    }),
  );
}

function superviseChildren({
  root,
  paths = developmentPaths(root),
  presenter,
  signals,
  electronExecutable,
  readinessTimeoutMs = 30_000,
  outputDrainGraceMs = 5_000,
  spawnChild = spawn,
}) {
  return Effect.async((resume) => {
    let settled = false;
    let webReady = false;
    let webUrl;
    let desktop;
    let unsubscribeSignal = () => {};
    const runtimeDecoders = new Map();
    const outputDrains = new Set();
    const environment = createDesktopEnvironment(process.env, root);
    const webEnvironment = createWebEnvironment(process.env);
    const web = spawnManaged(spawnChild, process.execPath, ['scripts/vite-launcher.mjs', 'dev'], {
      cwd: resolve(root, 'apps/web'),
      env: webEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(
      () => terminal({ exitCode: 1, message: 'Timed out waiting for ISAGI_WEB_READY.' }),
      readinessTimeoutMs,
    );
    timeout.unref();

    const webStdout = createRecordDecoder((record, ending) => {
      const line = withoutEnding(record, ending);
      let readiness;
      try {
        readiness = parseWebReadiness(line);
      } catch (cause) {
        terminal({ exitCode: 1, message: errorMessage(cause) });
        return;
      }
      if (!readiness) {
        presenter({ source: 'web', stream: 'stdout', payload: record });
        return;
      }
      if (webReady) {
        terminal({ exitCode: 1, message: 'Web launcher emitted duplicate readiness.' });
        return;
      }
      if (!isLoopbackUrl(readiness.url)) {
        terminal({
          exitCode: 1,
          message: `Web launcher published a non-loopback URL: ${readiness.url}`,
        });
        return;
      }
      webReady = true;
      webUrl = readiness.url;
      clearTimeout(timeout);
      presenter({ source: 'web', stream: 'stdout', payload: `ready at ${readiness.url}\n` });
      maybeStartDesktop();
    });
    outputDrains.add(pipeDecodedStream(web.stdout, webStdout));
    outputDrains.add(pipeStream(web.stderr, 'web', 'stderr', presenter));
    web.once('error', (cause) =>
      terminal({ exitCode: 1, message: `Web failed to start: ${errorMessage(cause)}` }),
    );
    web.once('exit', (code, signal) => {
      const selected = exitCodeForResult({ code, signal });
      terminal({
        exitCode: selected === 0 ? 1 : selected,
        message: `Web exited ${webReady ? 'while Electron was active' : 'before readiness'} (${describeExit(code, signal)}).`,
      });
    });
    unsubscribeSignal =
      signals?.subscribe(({ exitCode }) => void terminal({ exitCode })) ?? (() => {});

    async function terminal(result) {
      if (settled) return;
      settled = true;
      unsubscribeSignal();
      clearTimeout(timeout);
      if (result.message)
        presenter({ source: 'dev', stream: 'stderr', payload: `${result.message}\n` });
      await safeShutdownChildren(desktop, web, presenter);
      await drainOutput(outputDrains, presenter, outputDrainGraceMs);
      for (const decoder of runtimeDecoders.values()) decoder.end();
      resume(Effect.succeed(result.exitCode));
    }

    return Effect.promise(async () => {
      if (settled) return;
      settled = true;
      unsubscribeSignal();
      clearTimeout(timeout);
      await safeShutdownChildren(desktop, web, presenter);
      await drainOutput(outputDrains, presenter, outputDrainGraceMs);
      for (const decoder of runtimeDecoders.values()) decoder.end();
    });

    function maybeStartDesktop() {
      if (settled || desktop || !webReady || !webUrl) return;
      desktop = spawnManaged(spawnChild, electronExecutable, ['.'], {
        cwd: paths.desktopRoot,
        env: { ...environment, [developmentEnvironmentKeys.webUrl]: webUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const drain of pipeDesktopLogs(desktop, presenter, runtimeDecoders, terminal)) {
        outputDrains.add(drain);
      }
      desktop.once('error', (cause) =>
        terminal({ exitCode: 1, message: `Electron failed to start: ${errorMessage(cause)}` }),
      );
      desktop.once('exit', (code, signal) => {
        const exitCode = exitCodeForResult({ code, signal });
        terminal({
          exitCode,
          message:
            exitCode === 0
              ? undefined
              : `Electron exited unexpectedly (${describeExit(code, signal)}).`,
        });
      });
    }
  });
}

function createSupervisorSignalSource(signalProcess = process) {
  let selected;
  const listeners = new Set();
  const select = (signal, exitCode) => {
    if (selected) return;
    selected = { signal, exitCode };
    for (const listener of [...listeners]) listener(selected);
  };
  const onInterrupt = () => select('SIGINT', 130);
  const onTerminate = () => select('SIGTERM', 143);
  signalProcess.once('SIGINT', onInterrupt);
  signalProcess.once('SIGTERM', onTerminate);
  return {
    get selected() {
      return selected;
    },
    subscribe(listener) {
      if (selected) listener(selected);
      else listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
      signalProcess.off('SIGINT', onInterrupt);
      signalProcess.off('SIGTERM', onTerminate);
    },
  };
}

function spawnManaged(spawnChild, command, args, options) {
  const child = spawnChild(command, args, {
    ...options,
    detached: false,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
  registerOwnedProcess(child);
  return child;
}

function registerOwnedProcess(child) {
  if (!child.pid || typeof process.send !== 'function') return;
  sendOwnerMessage({
    protocolVersion: developmentProtocolVersion,
    type: 'owned_process_started',
    pid: child.pid,
  });
  child.once('exit', () =>
    sendOwnerMessage({
      protocolVersion: developmentProtocolVersion,
      type: 'owned_process_exited',
      pid: child.pid,
    }),
  );
}

function sendOwnerMessage(message) {
  if (!process.connected || typeof process.send !== 'function') return;
  process.send(message, () => {});
}

function pipeStream(stream, source, streamName, presenter) {
  const decoder = createRecordDecoder((payload) =>
    presenter({ source, stream: streamName, payload }),
  );
  return pipeDecodedStream(stream, decoder);
}

function pipeDecodedStream(stream, decoder) {
  stream.setEncoding('utf8');
  return new Promise((resolvePromise) => {
    let complete = false;
    const finish = () => {
      if (complete) return;
      complete = true;
      decoder.end();
      resolvePromise();
    };
    stream.on('data', (chunk) => decoder.write(chunk));
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
    if (stream.readableEnded || stream.destroyed) queueMicrotask(finish);
  });
}

function pipeDesktopLogs(child, presenter, runtimeDecoders, onFailure) {
  const desktopDecoder = createRecordDecoder((record, ending) => {
    const line = withoutEnding(record, ending);
    let runtimeRecord;
    try {
      runtimeRecord = parseRuntimeLog(line);
    } catch (cause) {
      onFailure({ exitCode: 1, message: errorMessage(cause) });
      return;
    }
    if (!runtimeRecord) {
      presenter({ source: 'desktop', stream: 'stdout', payload: record });
      return;
    }
    let decoder = runtimeDecoders.get(runtimeRecord.stream);
    if (!decoder) {
      decoder = createRecordDecoder((payload) =>
        presenter({ source: 'runtime', stream: runtimeRecord.stream, payload }),
      );
      runtimeDecoders.set(runtimeRecord.stream, decoder);
    }
    decoder.write(runtimeRecord.payload);
  });
  return [
    pipeDecodedStream(child.stdout, desktopDecoder),
    pipeStream(child.stderr, 'desktop', 'stderr', presenter),
  ];
}

async function drainOutput(outputDrains, presenter, graceMs) {
  let timeout;
  const drained = await Promise.race([
    Promise.all(outputDrains).then(() => true),
    new Promise((resolvePromise) => {
      timeout = setTimeout(() => resolvePromise(false), graceMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (drained) return;
  presenter({
    source: 'dev',
    stream: 'stderr',
    payload: 'Timed out draining child output; escalating residual cleanup to the stack owner.\n',
  });
}

async function shutdownChildren(desktop, web) {
  if (desktop) await terminateChild(desktop);
  if (web) await terminateChild(web);
}

async function safeShutdownChildren(desktop, web, presenter) {
  try {
    await shutdownChildren(desktop, web);
  } catch (cause) {
    presenter({
      source: 'dev',
      stream: 'stderr',
      payload: `Cleanup failed: ${errorMessage(cause)}\n`,
    });
  }
}

async function terminateChild(child, graceMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid) return;
  sendSignal(child, 'SIGTERM');
  if (await waitForExit(child, graceMs)) return;
  sendSignal(child, 'SIGKILL');
  await waitForExit(child, graceMs);
}

function sendSignal(child, signal) {
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => resolvePromise(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolvePromise(true);
    });
  });
}

async function validateRepositoryRoot(root) {
  await Promise.all([
    access(`${root}/package.json`),
    access(`${root}/pnpm-workspace.yaml`),
    access(`${root}/apps/desktop/package.json`),
    access(`${root}/apps/web/package.json`),
  ]).catch(() => {
    throw failure(`Resolved development root is not an Isagi checkout: ${root}`);
  });
}

function withoutEnding(record, ending) {
  return ending ? record.slice(0, -ending.length) : record;
}

function failure(message, exitCode = 1) {
  return new SupervisorFailure({ message, exitCode });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function describeExit(code, signal) {
  if (typeof code === 'number') return `code ${code}`;
  if (signal) return `signal ${signal}`;
  return 'unknown result';
}

function createDesktopEnvironment(environment, root) {
  const inherited = { ...environment };
  delete inherited.ELECTRON_RUN_AS_NODE;
  delete inherited.ISAGI_RUNTIME_URL;
  delete inherited.VITE_ISAGI_RUNTIME_URL;
  delete inherited[developmentEnvironmentKeys.webUrl];
  inherited[developmentEnvironmentKeys.worktreeRoot] = root;
  inherited[developmentEnvironmentKeys.desktopLogMode] = 'supervisor';
  inherited[developmentEnvironmentKeys.processOwner] = '1';
  inherited.ISAGI_RUNTIME_DEBUG ??= '1';
  return inherited;
}

function createWebEnvironment(environment) {
  const inherited = { ...environment };
  delete inherited.VITE_ISAGI_RUNTIME_URL;
  return inherited;
}

function resolveElectronExecutable(desktopRoot) {
  const require = createRequire(resolve(desktopRoot, 'package.json'));
  const executable = require('electron');
  if (typeof executable !== 'string') {
    throw failure(`Could not resolve the Electron executable from ${desktopRoot}.`);
  }
  return executable;
}

export {
  createDesktopEnvironment,
  createWebEnvironment,
  createSupervisorSignalSource,
  superviseChildren,
  terminateChild,
};
