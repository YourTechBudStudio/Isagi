// Effect v3 APIs never return (verification §3.3). In `.ts`/`.tsx` the compiler already rejects these names: none of
// them exists in effect 4.0.2 (checked with runtime `in` probes). This scan exists for the untyped `.mjs` Effect
// consumers (`scripts/`, `apps/desktop/scripts/`) and as one greppable list of what the port removed. It also bans the
// v3-era packages and the `effect/unstable/*` subpaths, which stable v4 does not ship.
//
// Look-alikes that are valid v4 and must not be flagged: `Effect.forkChild`, `Effect.catch`, `Effect.catchCause`,
// `Effect.callback`, `Effect.Services`, `Context.Service`, `Layer.effect`, `Layer.unwrap`, `Stream.callback`.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule, listSources, matchesOf, rel } from './source-files.mjs';

/** Directories scanned, relative to the repo root (tests included: they must not use v3 APIs either). */
export const SCANNED_DIRS = ['apps', 'packages', 'scripts'];

// The checks' own sources and fixtures spell the banned names.
const SELF = 'scripts/architecture/';

export const V3_API = new RegExp(
  [
    String.raw`\bEffect\.(?:catchAll|catchAllCause|catchAllDefect|either|zipRight|zipLeft|async|fork|forkDaemon|tapErrorCause|orElse|Tag|Service|runtime|locally|makeSemaphore|unsafeMakeSemaphore)\b`,
    String.raw`\bContext\.(?:GenericTag|Tag|unsafeMap)\b`,
    String.raw`\bLayer\.(?:scoped|scopedDiscard|unwrapEffect)\b`,
    String.raw`\bStream\.(?:async|asyncScoped|asyncPush)\b`,
    String.raw`\bRuntime\.run(?:Promise|Sync|Fork)\w*\b`,
    // `from '<x>'`, side-effect `import '<x>'` and `import('<x>')`, for the package itself or any subpath.
    String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*)['"](?:@effect\/schema|@effect\/platform|effect\/unstable)(?:\/[^'"]*)?['"]`,
  ].join('|'),
  'g',
);

/**
 * @param {string} repoRoot absolute repo root
 * @returns {string[]} one message per hit; empty when no v3 API remains
 */
export const checkEffectV3Apis = (repoRoot) => {
  /** @type {string[]} */
  const errors = [];
  for (const dir of SCANNED_DIRS) {
    const abs = join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    for (const file of listSources(abs)) {
      const fileRel = rel(repoRoot, file);
      if (fileRel.startsWith(SELF)) continue;
      for (const hit of matchesOf(file, V3_API)) {
        errors.push(
          `${fileRel}:${hit.line}: ${hit.text} is an Effect v3 API (see the v3-to-v4 cookbook for its v4 name)`,
        );
      }
    }
  }
  return errors;
};

if (isMainModule(import.meta.url)) {
  const repoRoot = resolve(
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  const errors = checkEffectV3Apis(repoRoot);
  for (const error of errors) console.error(error);
  console.error(`effect-v3-apis: ${errors.length} violation(s)`);
  process.exit(errors.length > 0 ? 1 : 0);
}
