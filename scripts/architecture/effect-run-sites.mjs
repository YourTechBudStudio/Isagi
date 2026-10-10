// Effect programs are run only at sanctioned boundaries: process entry points, framework/IPC/socket adapters, and the
// Promise bridge of the public workflow SDK. A run site anywhere else re-enters Effect from inside a module and loses
// interruption, scope, and error typing.
//
// Allowlist: scripts/architecture/effect-run-sites.json, `{ "<repo-relative file>": "<why this file is a boundary>" }`.
// It is a ratchet: units delete entries when they remove a file's run sites (plan R28); adding an entry needs
// integrator approval. The check fails on a run site in an unlisted production file and on a listed file that no
// longer has one (stale entry).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule, isTestFile, listSources, matchesOf, rel } from './source-files.mjs';

export const ALLOWLIST_PATH = 'scripts/architecture/effect-run-sites.json';

/** Directories scanned, relative to the repo root. Test files inside them are skipped. */
export const SCANNED_DIRS = [
  'apps/runtime/src',
  'apps/desktop/src',
  'apps/cli/src',
  'apps/web/src',
  'packages/runtime-client/src',
  'packages/contracts/src',
  'scripts',
];

// The checks' own sources mention the patterns they look for.
const SELF = 'scripts/architecture/';

/**
 * `Effect.run{Promise,Sync,Fork,Callback}` with optional `Exit`/`With` suffixes (v3 and v4 names), `run*` called on a
 * runtime value named `runtime`/`managedRuntime`/`rt`, and `ManagedRuntime.make`.
 */
export const RUN_SITE =
  /\bEffect\.run(?:Promise|Sync|Fork|Callback)(?:Exit)?(?:With)?\b|\b(?:runtime|managedRuntime|rt)\.run(?:Promise|Sync|Fork|Callback)(?:Exit)?\b|\bManagedRuntime\.make\b/g;

/**
 * Reads and validates the allowlist. A missing or malformed file is an error, not an empty list.
 * @param {string} allowlistPath absolute path
 * @returns {Record<string, string>}
 */
export const readAllowlist = (allowlistPath) => {
  if (!existsSync(allowlistPath))
    throw new Error(`effect-run-sites: allowlist ${allowlistPath} does not exist`);
  const parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `effect-run-sites: allowlist ${allowlistPath} must be a JSON object of file -> reason`,
    );
  }
  return parsed;
};

/**
 * @param {string} repoRoot absolute repo root
 * @param {string} [allowlistPath] absolute allowlist path; defaults to the committed allowlist under `repoRoot`
 * @returns {string[]} one message per violation; empty when the repo conforms
 */
export const checkEffectRunSites = (repoRoot, allowlistPath = join(repoRoot, ALLOWLIST_PATH)) => {
  const allow = readAllowlist(allowlistPath);
  /** @type {string[]} */
  const errors = [];
  for (const [file, reason] of Object.entries(allow)) {
    if (typeof reason !== 'string' || reason.trim() === '')
      errors.push(`${file}: allowlist entry needs a reason (why this file is a run-site boundary)`);
  }
  const seen = new Set();
  for (const dir of SCANNED_DIRS) {
    const abs = join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    for (const file of listSources(abs)) {
      const fileRel = rel(repoRoot, file);
      if (isTestFile(fileRel) || fileRel.startsWith(SELF)) continue;
      const hits = matchesOf(file, RUN_SITE);
      if (hits.length === 0) continue;
      seen.add(fileRel);
      if (Object.hasOwn(allow, fileRel)) continue;
      for (const hit of hits) {
        errors.push(
          `${fileRel}:${hit.line}: ${hit.text} runs an Effect outside a sanctioned boundary (run it at the caller's boundary, or ask the integrator to allowlist this file in ${ALLOWLIST_PATH})`,
        );
      }
    }
  }
  for (const file of Object.keys(allow)) {
    if (!seen.has(file))
      errors.push(
        `${file}: allowlisted in ${ALLOWLIST_PATH} but has no Effect run site; delete the stale entry`,
      );
  }
  return errors;
};

if (isMainModule(import.meta.url)) {
  const repoRoot = resolve(
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  const errors = checkEffectRunSites(repoRoot);
  for (const error of errors) console.error(error);
  console.error(`effect-run-sites: ${errors.length} violation(s)`);
  process.exit(errors.length > 0 ? 1 : 0);
}
