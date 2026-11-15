#!/usr/bin/env node
// Runs the runtime test suite as parallel shards (`node --test --test-shard=i/n`).
//
//   node scripts/test-shards.mjs
//
// Each shard is one test process with isolation off: tsx loads the module graph once per shard instead of once per file,
// and tests inside a shard still run one at a time, so the process-wide leak probes in `test/test-support.ts` stay
// valid. Tests are spread across processes, never run concurrently inside one. Every shard runs under
// `test-exit-watchdog.mjs`, so a shard that hangs names its leak. Output is buffered per shard: a passing shard prints
// its summary line, a failing one prints its whole report.
//
// `ISAGI_TEST_SHARDS` sets the shard count (default 4).
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const shardCount = Number(process.env.ISAGI_TEST_SHARDS ?? 4);
if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
  process.stderr.write(
    `test-shards: ISAGI_TEST_SHARDS must be a positive integer, got ${shardCount}\n`,
  );
  process.exit(2);
}

const runtimeRoot = fileURLToPath(new URL('..', import.meta.url));
const watchdog = fileURLToPath(new URL('../../../scripts/test-exit-watchdog.mjs', import.meta.url));
const watchdogSeconds = '240';
const testFiles = ['src/**/*.test.ts', 'test/**/*.test.ts'];

const children = new Set();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}

function runShard(index) {
  const shard = `${index}/${shardCount}`;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        watchdog,
        watchdogSeconds,
        '--',
        process.execPath,
        '--import',
        'tsx',
        '--import',
        './test/dump-handles-on-signal.mjs',
        '--test',
        '--experimental-test-isolation=none',
        `--test-shard=${shard}`,
        ...testFiles,
      ],
      { cwd: runtimeRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.add(child);
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    child.on('error', (error) => {
      output.push(Buffer.from(`test-shards: could not start shard ${shard}: ${error.message}\n`));
    });
    child.on('close', (code, signal) => {
      children.delete(child);
      const report = Buffer.concat(output).toString('utf8');
      const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
      const passed = code === 0;
      const counts = ['tests', 'pass', 'fail']
        .map((name) => report.match(new RegExp(`^ℹ ${name} (\\d+)$`, 'm'))?.[0].slice(2))
        .filter(Boolean)
        .join(', ');
      if (!passed) process.stdout.write(`\n===== shard ${shard} report =====\n${report}\n`);
      process.stdout.write(
        `test-shards: shard ${shard} ${passed ? 'passed' : `failed (${signal ?? `exit ${code}`})`} in ${seconds}s${counts ? ` (${counts})` : ''}\n`,
      );
      resolve(passed);
    });
  });
}

const results = await Promise.all(
  Array.from({ length: shardCount }, (_, index) => runShard(index + 1)),
);
const failed = results.filter((passed) => !passed).length;
if (failed > 0) process.stderr.write(`test-shards: ${failed} of ${shardCount} shards failed\n`);
process.exit(failed > 0 ? 1 : 0);
