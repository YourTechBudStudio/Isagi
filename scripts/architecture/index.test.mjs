import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALLOWLIST_PATH } from './effect-run-sites.mjs';
import { CHECKS, runArchitectureChecks } from './index.mjs';
import { CONFIG_PATH } from './module-boundaries.mjs';

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

test('reportRules keeps those rules report-only under enforce: printed and counted, never failing', () => {
  const rules = (violations) => [
    { check: 'mb', mode: 'enforce', reportRules: ['R9'], run: () => violations },
  ];
  const onlyReported = run(rules(['R9 a.ts:1: child_process', 'R9 b.ts:2: child_process']));
  assert.equal(onlyReported.exitCode, 0);
  assert.deepEqual(onlyReported.out, [
    'R9 a.ts:1: child_process',
    'R9 b.ts:2: child_process',
    'mb [enforce]: 0 violation(s), 2 report-only (R9)',
  ]);
  assert.deepEqual(onlyReported.err, []);
  assert.deepEqual(onlyReported.results, [
    { check: 'mb', mode: 'enforce', violations: 0, reportOnly: 2, failed: false, crashed: false },
  ]);

  const mixed = run(
    rules(['R9 a.ts:1: child_process', 'R2 c.ts:3: deep import', 'R90 d.ts:4: other rule']),
  );
  assert.equal(mixed.exitCode, 1);
  assert.deepEqual(mixed.out, ['R9 a.ts:1: child_process']);
  assert.deepEqual(mixed.err, [
    'R2 c.ts:3: deep import',
    'R90 d.ts:4: other rule',
    'mb [enforce]: 2 violation(s), 1 report-only (R9)',
  ]);
});

test('reportRules under report mode splits the count and prints no violations', () => {
  const result = run([
    {
      check: 'mb',
      mode: 'report',
      reportRules: ['R9'],
      run: () => ['R9 a.ts:1: x', 'R2 b.ts:1: y'],
    },
  ]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.out, ['mb [report]: 1 violation(s), 1 report-only (R9)']);
  assert.deepEqual(result.err, []);
});

test('malformed reportRules are a configuration error', () => {
  for (const reportRules of [[], [''], ['R 9'], 'R9']) {
    assert.throws(
      () => run([{ check: 'mb', mode: 'enforce', reportRules, run: () => [] }]),
      /invalid reportRules/,
    );
  }
});

test('the registry enforces module-boundaries with R9 report-only (plan R27)', () => {
  assert.deepEqual(
    CHECKS.filter(({ check }) => check === 'module-boundaries').map(
      ({ check, mode, reportRules }) => ({ check, mode, reportRules }),
    ),
    [{ check: 'module-boundaries', mode: 'enforce', reportRules: ['R9'] }],
  );
});

test('the registry enforces effect-run-sites', () => {
  assert.deepEqual(
    CHECKS.map(({ check, mode }) => ({ check, mode })).filter(
      ({ check }) => check === 'effect-run-sites',
    ),
    [{ check: 'effect-run-sites', mode: 'enforce' }],
  );
});

test('the registry enforces dependency-policy D2/D3 and keeps D1 report-only until S4.Z', () => {
  assert.deepEqual(
    CHECKS.filter(({ check }) => check === 'dependency-policy').map(
      ({ check, mode, reportRules }) => ({ check, mode, reportRules }),
    ),
    [{ check: 'dependency-policy', mode: 'enforce', reportRules: ['D1'] }],
  );
});

test('the registry enforces effect-v3-apis', () => {
  assert.deepEqual(
    CHECKS.filter(({ check }) => check === 'effect-v3-apis').map(
      ({ check, mode, reportRules }) => ({
        check,
        mode,
        reportRules,
      }),
    ),
    [{ check: 'effect-v3-apis', mode: 'enforce', reportRules: undefined }],
  );
});

test('the CLI runs the registry against the given repo root and sets the exit code', () => {
  const repo = mkdtempSync(join(tmpdir(), 'isagi-architecture-'));
  try {
    mkdirSync(join(repo, 'apps/runtime/src'), { recursive: true });
    mkdirSync(dirname(join(repo, ALLOWLIST_PATH)), { recursive: true });
    writeFileSync(join(repo, ALLOWLIST_PATH), '{}');
    writeFileSync(join(repo, 'apps/runtime/src/a.ts'), 'export {};');
    // dependency-policy reads the workspace manifests and the lockfile.
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ devDependencies: { effect: 'catalog:' } }),
    );
    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'packages:\n  effect@4.0.2:\n');
    writeFileSync(
      join(repo, CONFIG_PATH),
      JSON.stringify({ root: 'apps/runtime/src', compositionRoot: ['a.ts'], modules: {} }),
    );
    const clean = spawnSync(process.execPath, [indexPath, repo], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /effect-run-sites \[enforce\]: 0 violation\(s\)/);
    assert.match(
      clean.stdout,
      /module-boundaries \[enforce\]: 0 violation\(s\), 0 report-only \(R9\)/,
    );
    assert.match(
      clean.stdout,
      /dependency-policy \[enforce\]: 0 violation\(s\), 0 report-only \(D1\)/,
    );
    assert.match(clean.stdout, /effect-v3-apis \[enforce\]: 0 violation\(s\)/);

    writeFileSync(join(repo, 'apps/runtime/src/a.ts'), 'void Effect.runPromise(e);');
    const failing = spawnSync(process.execPath, [indexPath, repo], { encoding: 'utf8' });
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /apps\/runtime\/src\/a\.ts:1: Effect\.runPromise/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
