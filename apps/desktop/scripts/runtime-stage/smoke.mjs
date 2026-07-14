import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import { Effect } from 'effect';

import { StageOperationError, StageValidationError } from './errors.mjs';
import { repoRoot, stageRoot } from './paths.mjs';
import { runCommand } from './process.mjs';
import { validateStage } from './stage.mjs';

const readyPrefix = 'ISAGI_RUNTIME_READY ';

export function smokeRuntimeStage(root = stageRoot) {
  return Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(resolve(tmpdir(), 'isagi-runtime-stage-smoke-'))),
    (temporaryRoot) =>
      Effect.gen(function* () {
        const metadata = yield* tryOperation('metadata read', root, () =>
          readJson(resolve(root, 'runtime-stage.json')),
        );
        yield* tryOperation('runtime stage validation', root, () =>
          validateStage(root, metadata.dependencyVersions),
        );

        const electron = yield* inspectElectron();
        assertElectronMatchesStage(electron, metadata.electron);
        yield* smokeOneStage(root, temporaryRoot, electron);

        const relocatedRoot = resolve(temporaryRoot, 'relocated-runtime');
        yield* tryOperation('relocation copy', relocatedRoot, () =>
          cpSync(root, relocatedRoot, { recursive: true, verbatimSymlinks: true }),
        );
        yield* tryOperation('relocated stage validation', relocatedRoot, () =>
          validateStage(relocatedRoot, metadata.dependencyVersions),
        );
        yield* smokeOneStage(relocatedRoot, temporaryRoot, electron);

        console.log(
          `[desktop] Runtime stage smoke passed for ${root} and a relocated copy under Electron ${electron.version} (Node ${electron.node}, ABI ${electron.abi})`,
        );
      }),
    (temporaryRoot) =>
      Effect.sync(() => rmSync(temporaryRoot, { recursive: true, force: true })).pipe(
        Effect.ignore,
      ),
  );
}

function smokeOneStage(root, workingDirectory, electron) {
  return Effect.gen(function* () {
    yield* runPtyProbe(root, workingDirectory, electron.executable);
    const health = yield* runRuntimeProbe(root, workingDirectory, electron.executable);
    if (
      health.node !== electron.node ||
      health.platform !== electron.platform ||
      health.arch !== electron.arch
    ) {
      return yield* Effect.fail(
        new StageValidationError({
          path: root,
          reason: `health context ${health.node}/${health.platform}/${health.arch} does not match Electron ${electron.node}/${electron.platform}/${electron.arch}`,
        }),
      );
    }
  });
}

function runPtyProbe(root, workingDirectory, electronExecutable) {
  return runCommand(
    electronExecutable,
    [
      resolve(dirname(import.meta.dirname), 'runtime-stage/pty-probe.mjs'),
      resolve(root, 'package.json'),
    ],
    {
      capture: true,
      cwd: workingDirectory,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: 15_000,
    },
  ).pipe(
    Effect.flatMap(({ stdout }) =>
      stdout.includes('ISAGI_RUNTIME_PTY_PROBE_READY')
        ? Effect.void
        : Effect.fail(
            new StageValidationError({ path: root, reason: 'node-pty probe did not complete' }),
          ),
    ),
  );
}

function runRuntimeProbe(root, workingDirectory, electronExecutable) {
  return Effect.async((resume) => {
    const dataRoot = resolve(workingDirectory, `data-${Date.now()}-${Math.random()}`);
    const child = spawn(electronExecutable, [resolve(root, 'index.js')], {
      cwd: workingDirectory,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        HOST: '127.0.0.1',
        ISAGI_DATA_DIR: dataRoot,
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdout = '';
    let stdoutCarry = '';
    let stderr = '';
    let requestedShutdown = false;
    let failureInProgress = false;
    let forceKillTimeout;
    const timeout = setTimeout(
      () => finishFailure(new Error('runtime readiness timed out')),
      30_000,
    );

    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      rmSync(dataRoot, { recursive: true, force: true });
    };
    const settle = (effect) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(effect);
    };
    const finishFailure = (cause) => {
      if (settled || failureInProgress) return;
      failureInProgress = true;
      const failure = Effect.fail(
        new StageOperationError({
          operation: `runtime smoke (${stdout.trim()} ${stderr.trim()})`,
          path: root,
          cause,
        }),
      );
      if (child.exitCode !== null || child.signalCode !== null) {
        settle(failure);
        return;
      }
      child.once('exit', () => settle(failure));
      child.kill('SIGTERM');
      forceKillTimeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const parsed = takeCompleteLines(stdoutCarry, chunk);
      stdoutCarry = parsed.carry;
      for (const line of parsed.lines) {
        if (!line.startsWith(readyPrefix) || requestedShutdown) continue;
        requestedShutdown = true;
        void checkHealth(line.slice(readyPrefix.length))
          .then((health) => {
            child.once('exit', (code, signal) => {
              if (code === 0) settle(Effect.succeed(health));
              else finishFailure(new Error(`runtime shutdown exited ${code ?? signal}`));
            });
            child.kill('SIGTERM');
          })
          .catch(finishFailure);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', finishFailure);
    child.once('exit', (code, signal) => {
      if (!settled && !requestedShutdown) {
        finishFailure(new Error(`runtime exited before readiness: ${code ?? signal}`));
      }
    });

    return Effect.sync(() => {
      if (!settled) child.kill('SIGTERM');
    });
  });
}

export function takeCompleteLines(carry, chunk) {
  const parts = `${carry}${chunk}`.split(/\r?\n/);
  return { carry: parts.pop(), lines: parts };
}

async function checkHealth(readyJson) {
  const { url } = JSON.parse(readyJson);
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1')
    throw new Error(`Unexpected runtime host ${parsed.hostname}.`);
  const response = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Runtime health returned HTTP ${response.status}.`);
  const body = await response.json();
  if (body?.data?.ok !== true) throw new Error('Runtime health response was not healthy.');
  return body.data.context;
}

function inspectElectron() {
  const manifest = resolve(repoRoot, 'apps/desktop/package.json');
  const require = createRequire(manifest);
  const executable = require('electron');
  const source =
    'console.log(JSON.stringify({version:process.versions.electron,node:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch}))';
  return runCommand(executable, ['-e', source], {
    capture: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeoutMs: 15_000,
  }).pipe(
    Effect.flatMap(({ stdout }) =>
      tryOperation('Electron runtime inspection', executable, () => ({
        ...JSON.parse(stdout.trim()),
        executable,
      })),
    ),
  );
}

function assertElectronMatchesStage(actual, expected) {
  for (const key of ['abi', 'arch', 'node', 'platform', 'version']) {
    if (actual[key] !== expected[key]) {
      throw new StageValidationError({
        path: stageRoot,
        reason: `stage Electron ${key} ${expected[key]} does not match executable ${actual[key]}`,
      });
    }
  }
}

function tryOperation(operation, path, run) {
  return Effect.try({
    try: run,
    catch: (cause) => (cause?._tag ? cause : new StageOperationError({ operation, path, cause })),
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
