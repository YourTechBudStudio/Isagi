// Runs every architecture check (`pnpm lint` ends with `node scripts/architecture/index.mjs`).
//
// Each check is `(repoRoot) => string[]`, one message per violation. Its mode decides what a violation does:
//   enforce  print every violation; any violation fails the run (exit 1)
//   report   print only the count and exit 0; used while a stage drives a new check's count to zero
// `reportRules` (optional) lists rule ids whose violations stay report-only even under `enforce`: they are printed and
// counted but never fail the run (plan R27: module-boundaries R9 until its last five files move). A violation belongs
// to rule `X` when its message starts with `X ` (module-boundaries messages start with their rule id).
// A check that throws fails the run in either mode: a broken checker must not read as a clean tree.
// To see a report-mode check's violations, run its script directly (e.g. `node scripts/architecture/<check>.mjs`).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkEffectRunSites } from './effect-run-sites.mjs';
import { checkModuleBoundaries } from './module-boundaries.mjs';
import { isMainModule } from './source-files.mjs';

/** @typedef {'enforce' | 'report'} CheckMode */
/** @typedef {{ check: string, mode: CheckMode, reportRules?: string[], run: (repoRoot: string) => string[] }} RegisteredCheck */
/** @typedef {{ check: string, mode: CheckMode, violations: number, reportOnly?: number, failed: boolean, crashed: boolean }} CheckResult */

/** @type {RegisteredCheck[]} */
export const CHECKS = [
  { check: 'effect-run-sites', mode: 'enforce', run: (repoRoot) => checkEffectRunSites(repoRoot) },
  {
    check: 'module-boundaries',
    mode: 'report',
    reportRules: ['R9'],
    run: (repoRoot) => checkModuleBoundaries(repoRoot),
  },
];

const MODES = new Set(['enforce', 'report']);

/** @param {string} violation @param {string[]} rules */
const inRules = (violation, rules) => rules.some((rule) => violation.startsWith(`${rule} `));

/**
 * @param {string} repoRoot absolute repo root
 * @param {RegisteredCheck[]} [checks]
 * @param {{ log?: (line: string) => void, error?: (line: string) => void }} [io]
 * @returns {{ exitCode: 0 | 1, results: CheckResult[] }}
 */
export const runArchitectureChecks = (repoRoot, checks = CHECKS, io = {}) => {
  const log = io.log ?? ((line) => console.log(line));
  const error = io.error ?? ((line) => console.error(line));
  /** @type {CheckResult[]} */
  const results = [];
  for (const { check, mode, reportRules, run } of checks) {
    if (!MODES.has(mode))
      throw new Error(`architecture: check ${check} has unknown mode ${JSON.stringify(mode)}`);
    if (
      reportRules !== undefined &&
      (!Array.isArray(reportRules) ||
        reportRules.length === 0 ||
        reportRules.some((rule) => typeof rule !== 'string' || !/^\S+$/.test(rule)))
    )
      throw new Error(
        `architecture: check ${check} has invalid reportRules ${JSON.stringify(reportRules)}`,
      );
    /** @type {string[]} */
    let all;
    try {
      all = run(repoRoot);
    } catch (cause) {
      error(
        `${check}: crashed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
      );
      results.push({ check, mode, violations: 0, failed: true, crashed: true });
      continue;
    }
    const rules = reportRules ?? [];
    const violations = all.filter((violation) => !inRules(violation, rules));
    const reportOnly = all.filter((violation) => inRules(violation, rules));
    const failed = mode === 'enforce' && violations.length > 0;
    if (mode === 'enforce') {
      for (const violation of violations) error(violation);
      for (const violation of reportOnly) log(violation);
    }
    const counted =
      reportRules === undefined
        ? ''
        : `, ${reportOnly.length} report-only (${reportRules.join(', ')})`;
    const line = `${check} [${mode}]: ${violations.length} violation(s)${counted}`;
    if (failed) error(line);
    else log(line);
    results.push({
      check,
      mode,
      violations: violations.length,
      ...(reportRules === undefined ? {} : { reportOnly: reportOnly.length }),
      failed,
      crashed: false,
    });
  }
  return { exitCode: results.some((result) => result.failed) ? 1 : 0, results };
};

if (isMainModule(import.meta.url)) {
  const repoRoot = resolve(
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  process.exitCode = runArchitectureChecks(repoRoot).exitCode;
}
