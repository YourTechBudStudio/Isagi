import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALLOWLIST_PATH } from './effect-run-sites.mjs';
import { CHECKS, runArchitectureChecks } from './index.mjs';

const indexPath = fileURLToPath(new URL('./index.mjs', import.meta.url));

/** Runs `checks` against a dummy root and captures what the runner prints. */
const run = (checks) => {
  const out = [];
  const err = [];
  const result = runArchitectureChecks('/repo', checks, {
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { ...result, out, err };
};

test('passes when every check is clean', () => {
  const result = run([
    { check: 'a', mode: 'enforce', run: () => [] },
    { check: 'b', mode: 'report', run: () => [] },
  ]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.out, ['a [enforce]: 0 violation(s)', 'b [report]: 0 violation(s)']);
  assert.deepEqual(result.err, []);
});

test('an enforced check with violations prints each one and fails', () => {
  const result = run([
    { check: 'clean', mode: 'enforce', run: () => [] },
    { check: 'strict', mode: 'enforce', run: () => ['x.ts:1: bad', 'y.ts:2: bad'] },
  ]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.err, ['x.ts:1: bad', 'y.ts:2: bad', 'strict [enforce]: 2 violation(s)']);
  assert.deepEqual(
    result.results.map((r) => [r.check, r.failed]),
    [
      ['clean', false],
      ['strict', true],
    ],
  );
});

test('a report-mode check prints only its count and does not fail', () => {
  const result = run([
    { check: 'trending', mode: 'report', run: () => ['x.ts:1: bad', 'y.ts:2: bad', 'z.ts:3: bad'] },
  ]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.out, ['trending [report]: 3 violation(s)']);
  assert.deepEqual(result.err, []);
  assert.deepEqual(result.results, [
    { check: 'trending', mode: 'report', violations: 3, failed: false, crashed: false },
  ]);
});

test('a crashing check fails the run in either mode and later checks still run', () => {
  const result = run([
    {
      check: 'broken',
      mode: 'report',
      run: () => {
        throw new Error('config missing');
      },
    },
    { check: 'after', mode: 'enforce', run: () => [] },
  ]);
  assert.equal(result.exitCode, 1);
  assert.match(result.err[0], /^broken: crashed: Error: config missing/);
  assert.deepEqual(result.out, ['after [enforce]: 0 violation(s)']);
});

test('an unknown mode is a configuration error', () => {
  assert.throws(() => run([{ check: 'typo', mode: 'warn', run: () => [] }]), /unknown mode "warn"/);
});

test('the registry enforces effect-run-sites', () => {
  assert.deepEqual(
    CHECKS.map(({ check, mode }) => ({ check, mode })).filter(
      ({ check }) => check === 'effect-run-sites',
    ),
    [{ check: 'effect-run-sites', mode: 'enforce' }],
  );
});

test('the CLI runs the registry against the given repo root and sets the exit code', () => {
  const repo = mkdtempSync(join(tmpdir(), 'isagi-architecture-'));
  try {
    mkdirSync(join(repo, 'apps/runtime/src'), { recursive: true });
    mkdirSync(dirname(join(repo, ALLOWLIST_PATH)), { recursive: true });
    writeFileSync(join(repo, ALLOWLIST_PATH), '{}');
    writeFileSync(join(repo, 'apps/runtime/src/a.ts'), 'export {};');
    const clean = spawnSync(process.execPath, [indexPath, repo], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /effect-run-sites \[enforce\]: 0 violation\(s\)/);

    writeFileSync(join(repo, 'apps/runtime/src/a.ts'), 'void Effect.runPromise(e);');
    const failing = spawnSync(process.execPath, [indexPath, repo], { encoding: 'utf8' });
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /apps\/runtime\/src\/a\.ts:1: Effect\.runPromise/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
