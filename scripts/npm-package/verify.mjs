#!/usr/bin/env node

// Installs a packed `@yourtechbudstudio/isagi` tarball into a clean prefix and exercises it as a user would: help
// without native modules, the error documents, and a real `isagi serve` on a free port. The release job publishes only
// a tarball this script passed. Usage: node scripts/npm-package/verify.mjs <tarball>

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { packageName } from './package.mjs';
import { readyUrl } from './ready-line.mjs';

const commandTimeoutMs = 15_000;
const installTimeoutMs = 10 * 60_000;
const readyTimeoutMs = 60_000;
const nativeModules = ['better-sqlite3', 'node-pty'];
const requiredEntries = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/isagi.mjs',
  'dist/index.js',
  'dist/assets/manifest.json',
  'dist/drizzle/meta/_journal.json',
  'web/index.html',
];
const allowedTopLevel = new Set(['package.json', 'README.md', 'LICENSE', 'dist', 'web']);

class StepFailure extends Error {
  constructor(message, output = '') {
    super(message);
    this.output = output;
  }
}

const tarballArgument = process.argv[2];
if (!tarballArgument) {
  console.error('usage: node scripts/npm-package/verify.mjs <tarball>');
  process.exit(2);
}
const tarball = resolve(tarballArgument);

const root = mkdtempSync(resolve(tmpdir(), 'isagi-npm-verify-'));
const prefix = resolve(root, 'prefix');
const home = resolve(root, 'home');
const data = resolve(root, 'data');
for (const directory of [prefix, home]) mkdirSync(directory, { recursive: true });
const installedRoot = resolve(prefix, 'lib/node_modules', packageName);
const environment = cleanEnvironment();

let currentStep = 'setup';
let exitCode = 0;
try {
  await step('tarball contents', checkTarballContents);
  await step('install into a clean prefix', install);
  const version = JSON.parse(readFileSync(resolve(installedRoot, 'package.json'), 'utf8')).version;
  await step('help and version', () => checkHelp(version));
  await step('help without native modules, serve reports runtime_load_failed', () =>
    withoutNativeModules(async () => {
      await checkHelp(version);
      await checkServeLoadFailure();
    }),
  );
  await step('error documents', checkErrorDocuments);
  await step('serve on a free port', checkServe);
} catch (error) {
  exitCode = 1;
  console.error(`\nverify:npm failed at step "${currentStep}": ${error.message}`);
  if (error.output) console.error(`--- captured output ---\n${error.output}\n--- end ---`);
} finally {
  rmSync(root, { recursive: true, force: true });
  console.log(`cleanup: removed ${root}`);
}
process.exit(exitCode);

async function step(name, check) {
  currentStep = name;
  const started = Date.now();
  await check();
  console.log(`ok: ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

async function checkTarballContents() {
  if (!existsSync(tarball)) throw new StepFailure(`no tarball at ${tarball}`);
  const listing = await run('tar', ['-tzf', tarball]);
  expectExit(listing, 0, 'tar -tzf');
  const entries = listing.stdout
    .split('\n')
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//u, ''));
  const missing = requiredEntries.filter((entry) => !entries.includes(entry));
  if (missing.length > 0) throw new StepFailure(`missing ${missing.join(', ')}`, listing.stdout);
  const unexpected = entries.filter(
    (entry) => !allowedTopLevel.has(entry.split('/')[0]) || entry.endsWith('.tsbuildinfo'),
  );
  if (unexpected.length > 0) {
    throw new StepFailure(`unexpected entries ${unexpected.join(', ')}`);
  }
  if (!entries.some((entry) => entry.startsWith('dist/assets/'))) {
    throw new StepFailure('dist/assets/ is empty', listing.stdout);
  }
  console.log(`     ${entries.length} entries; no source trees or build caches`);
}

async function install() {
  const result = await run('npm', ['install', '--global', '--prefix', prefix, tarball], {
    timeoutMs: installTimeoutMs,
  });
  expectExit(result, 0, 'npm install');
  if (!existsSync(resolve(prefix, 'bin/isagi'))) {
    throw new StepFailure('npm install did not link bin/isagi', result.output);
  }
}

async function checkHelp(version) {
  const versionResult = await isagi(['--version']);
  expectExit(versionResult, 0, 'isagi --version');
  if (!versionResult.stdout.includes(version)) {
    throw new StepFailure(`isagi --version did not print ${version}`, versionResult.output);
  }
  for (const args of [['--help'], ['serve', '--help']]) {
    const result = await isagi(args);
    expectExit(result, 0, `isagi ${args.join(' ')}`);
    if (!result.stdout.includes('EXAMPLES')) {
      throw new StepFailure(`isagi ${args.join(' ')} has no EXAMPLES`, result.output);
    }
  }
}

async function checkServeLoadFailure() {
  const result = await isagi(['serve', '--json', '--data-dir', data]);
  expectExit(result, 1, 'isagi serve --json without native modules');
  expectErrorDocument(result, 'runtime_load_failed');
}

async function withoutNativeModules(check) {
  const moved = [];
  try {
    for (const name of nativeModules) {
      const path = resolve(installedRoot, 'node_modules', name);
      if (!existsSync(path)) throw new StepFailure(`${name} is not installed at ${path}`);
      renameSync(path, `${path}.aside`);
      moved.push(path);
    }
    await check();
  } finally {
    for (const path of moved) renameSync(`${path}.aside`, path);
  }
}

async function checkErrorDocuments() {
  const usage = await isagi(['nope', '--json']);
  expectExit(usage, 2, 'isagi nope --json');
  expectErrorDocument(usage, 'cli_usage_invalid');
  const unreachable = await isagi([
    'workflows',
    'runs',
    'list',
    '--json',
    '--runtime-url',
    'http://127.0.0.1:9',
  ]);
  expectExit(unreachable, 1, 'isagi workflows runs list against a closed port');
  expectErrorDocument(unreachable, 'runtime_unreachable');
}

async function checkServe() {
  const child = spawn(resolve(prefix, 'bin/isagi'), ['serve', '--data-dir', data], {
    cwd: root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise((resolveExit) =>
    child.once('exit', (code, signal) => resolveExit({ code, signal })),
  );
  // Settled from the stream callback, so a malformed ready line reaches the step's failure report and cleanup.
  const ready = new Promise((resolveReady, rejectReady) => {
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      output += chunk;
      try {
        const url = readyUrl(stdout);
        if (url !== undefined) resolveReady(url);
      } catch (error) {
        rejectReady(new StepFailure(error.message));
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
  });

  try {
    const url = await Promise.race([
      ready,
      exited.then(({ code, signal }) => {
        throw new StepFailure(`isagi serve exited (${code ?? signal}) before it was ready`);
      }),
      delay(readyTimeoutMs).then(() => {
        throw new StepFailure(`isagi serve was not ready within ${readyTimeoutMs / 1000} s`);
      }),
    ]);
    const port = Number(new URL(url).port);
    if (!(port > 0)) throw new StepFailure(`ready URL ${url} has no non-zero port`);
    console.log(`     ready at ${url}`);

    const health = await fetch(`${url}/api/v1/health`);
    if (health.status !== 200)
      throw new StepFailure(`GET /api/v1/health returned ${health.status}`);

    const runs = await isagi(['workflows', 'runs', 'list', '--json', '--runtime-url', url]);
    expectExit(runs, 0, 'isagi workflows runs list');
    const listed = parseSingleDocument(runs);
    if (!Array.isArray(listed.items) || listed.items.length !== 0 || listed.nextCursor !== null) {
      throw new StepFailure(
        'workflows runs list did not return { items: [], nextCursor: null }',
        runs.output,
      );
    }

    child.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      delay(commandTimeoutMs).then(() => {
        throw new StepFailure(
          `isagi serve did not exit within ${commandTimeoutMs / 1000} s of SIGTERM`,
        );
      }),
    ]);
    if (result.code !== 0)
      throw new StepFailure(`isagi serve exited ${result.code ?? result.signal} after SIGTERM`);
  } catch (error) {
    if (error instanceof StepFailure && !error.output) error.output = output;
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function expectExit(result, code, description) {
  if (result.timedOut) throw new StepFailure(`${description} timed out`, result.output);
  if (result.code !== code) {
    throw new StepFailure(
      `${description} exited ${result.code ?? result.signal}, expected ${code}`,
      result.output,
    );
  }
}

function expectErrorDocument(result, code) {
  const document = parseSingleDocument(result);
  const error = document.error;
  if (error?.code !== code) throw new StepFailure(`expected error code ${code}`, result.output);
  for (const field of ['message', 'recovery']) {
    if (typeof error[field] !== 'string' || error[field] === '') {
      throw new StepFailure(`error document has no ${field}`, result.output);
    }
  }
  if (typeof error.context !== 'object' || error.context === null) {
    throw new StepFailure('error document has no context', result.output);
  }
}

function parseSingleDocument(result) {
  const lines = result.stdout.split('\n').filter(Boolean);
  if (lines.length !== 1)
    throw new StepFailure(`expected one stdout document, got ${lines.length} lines`, result.output);
  try {
    return JSON.parse(lines[0]);
  } catch {
    throw new StepFailure('stdout is not a JSON document', result.output);
  }
}

function isagi(args) {
  return run(resolve(prefix, 'bin/isagi'), args);
}

function run(command, args, { timeoutMs = commandTimeoutMs } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(new StepFailure(`could not run ${command} ${args.join(' ')}: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        output: `$ ${command} ${args.join(' ')}\n[stdout]\n${stdout}[stderr]\n${stderr}`,
      });
    });
  });
}

/**
 * The installed bin first on `PATH`, a throwaway `HOME`, and nothing that could point the CLI or npm elsewhere: no
 * `ISAGI_*` (so no port, data directory or runtime URL comes from the environment) and no `npm_config_*` inherited from
 * the invoking package manager.
 */
function cleanEnvironment() {
  const kept = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('ISAGI_') && !name.toLowerCase().startsWith('npm_'),
    ),
  );
  return {
    ...kept,
    HOME: home,
    USERPROFILE: home,
    PATH: [resolve(prefix, 'bin'), process.env.PATH].join(delimiter),
  };
}
