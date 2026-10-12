import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Cause, Exit } from 'effect';

import { runtimeTeardown } from './run-main.js';

/**
 * `runMain` owns process signals and `process.exit`, so it is exercised in child processes: each test runs a tiny
 * program under `tsx` (the same loader the runtime's tests and `pnpm dev` use) and observes its exit code and a
 * journal file the program's finalizer writes. The journal is a file, not stdout, because a pipe write right before
 * `process.exit` is not guaranteed to be flushed.
 */

const RUNTIME_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_MAIN = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'run-main.ts')).href;

let scratch: string;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'isagi-run-main-'));
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface ChildRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly journal: readonly string[];
  readonly stderr: string;
}

/**
 * Runs `body` (module code with `Effect`, `runMain`, `journal(line)` and the `ready()` effect in scope). When
 * `signal` is given, it is sent once the program has run `ready()`.
 */
const runChild = (name: string, body: string, signal?: NodeJS.Signals): Promise<ChildRun> => {
  const journalPath = join(scratch, `${name}.journal`);
  const source = [
    `import { appendFileSync } from 'node:fs';`,
    `import { Effect } from 'effect';`,
    `import { runMain } from ${JSON.stringify(RUN_MAIN)};`,
    `const journal = (line) => appendFileSync(${JSON.stringify(journalPath)}, line + '\\n');`,
    // Signal handlers are installed right after the main fiber starts, so readiness is reported only after the
    // program's first asynchronous step (a timer fires only after `runMain` has returned).
    `const ready = () => Effect.sleep('1 millis').pipe(Effect.andThen(Effect.sync(() => process.stdout.write('ready\\n'))));`,
    body,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      { cwd: RUNTIME_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let signalled = false;
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${name} did not exit in time; stderr:\n${stderr}`));
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (signal && !signalled && stdout.includes('ready\n')) {
        signalled = true;
        child.kill(signal);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code, exitSignal) => {
      clearTimeout(deadline);
      let journal: string[] = [];
      try {
        journal = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
      } catch {
        // The program wrote nothing.
      }
      resolve({ code, signal: exitSignal, journal, stderr });
    });
  });
};

const serveUntilInterrupted = `
runMain(
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => journal('finalizer ran')));
    yield* ready();
    return yield* Effect.never;
  }).pipe(Effect.scoped),
  { disableErrorReporting: true },
);
`;

describe('runMain', { skip: process.platform === 'win32' ? 'POSIX signals' : false }, () => {
  test('SIGTERM interrupts the program, runs its finalizers and exits 0', async () => {
    const run = await runChild('sigterm', serveUntilInterrupted, 'SIGTERM');
    assert.deepEqual(run.journal, ['finalizer ran']);
    assert.equal(run.code, 0, run.stderr);
  });

  test('SIGINT interrupts the program, runs its finalizers and exits 0', async () => {
    const run = await runChild('sigint', serveUntilInterrupted, 'SIGINT');
    assert.deepEqual(run.journal, ['finalizer ran']);
    assert.equal(run.code, 0, run.stderr);
  });

  test('a failing program exits 1 after its finalizers', async () => {
    const run = await runChild(
      'failure',
      `
runMain(
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => journal('finalizer ran')));
    return yield* Effect.fail(new Error('Invalid PORT value: x'));
  }).pipe(Effect.scoped),
  { disableErrorReporting: true },
);
`,
    );
    assert.deepEqual(run.journal, ['finalizer ran']);
    assert.equal(run.code, 1, run.stderr);
  });

  test('a finalizer failing during a signalled shutdown exits 1', async () => {
    const run = await runChild(
      'failing-finalizer',
      `
runMain(
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.die(new Error('close failed')));
    yield* ready();
    return yield* Effect.never;
  }).pipe(Effect.scoped),
  { disableErrorReporting: true },
);
`,
      'SIGTERM',
    );
    assert.equal(run.code, 1, run.stderr);
  });

  test('a program that completes exits 0 without forcing the exit', async () => {
    const run = await runChild(
      'success',
      `
process.on('exit', (code) => journal('exit ' + code));
const originalExit = process.exit;
process.exit = (code) => {
  journal('process.exit called');
  return originalExit(code);
};
runMain(Effect.sync(() => journal('done')));
`,
    );
    assert.deepEqual(run.journal, ['done', 'exit 0']);
    assert.equal(run.code, 0, run.stderr);
  });
});

describe('runtimeTeardown', () => {
  const codeFor = (exit: Exit.Exit<unknown, unknown>) => {
    let code: number | undefined;
    runtimeTeardown(exit, (value) => {
      code = value;
    });
    return code;
  };

  test('success and interruption-only exits are 0; failures and defects are 1', () => {
    assert.equal(codeFor(Exit.succeed('done')), 0);
    assert.equal(codeFor(Exit.interrupt(1)), 0);
    assert.equal(codeFor(Exit.fail(new Error('startup failed'))), 1);
    assert.equal(codeFor(Exit.die(new Error('defect'))), 1);
    assert.equal(
      codeFor(Exit.failCause(Cause.combine(Cause.interrupt(1), Cause.die(new Error('finalizer'))))),
      1,
    );
  });
});
