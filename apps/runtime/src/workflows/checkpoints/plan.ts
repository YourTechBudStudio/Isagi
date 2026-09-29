import { isAbsolute, posix } from 'node:path';

import { pureFailure, type PureResult } from '../state/pure.js';
import { isPlainObject } from '../state/reducers.js';

/**
 * Normalization of the plan a checkpoint's `plan` returned.
 *
 * Pure: it runs before anything touches the filesystem, so an author mistake fails the execution
 * (stage `checkpoint_plan`) with a message naming the field. The value is untrusted, so only the
 * fields a plan has are read, each is type-checked, and an optional field set to `undefined` counts
 * as absent. Every rule refuses rather than repairs: a silently dropped scope or exclusion would
 * save something other than what the author asked for.
 */

export interface NormalizedScope {
  readonly scope: string;
  readonly kind: 'directory' | 'file';
  /** Normalized root-relative path. */
  readonly path: string;
  /** Normalized scope-relative paths, sorted and deduplicated; `[]` for file scopes. */
  readonly exclude: readonly string[];
}

export interface NormalizedCheckpointPlan {
  readonly scopes: readonly NormalizedScope[];
}

export const checkpointMaxScopes = 64;
export const checkpointMaxExclusions = 64;
const scopeNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeCheckpointPlan(value: unknown): PureResult<NormalizedCheckpointPlan> {
  if (!isPlainObject(value) || !Array.isArray(value.capture)) {
    return pureFailure('A checkpoint plan must be an object with a `capture` array.');
  }

  const capture: readonly unknown[] = value.capture;
  if (capture.length > checkpointMaxScopes) {
    return pureFailure(`A plan captures at most ${checkpointMaxScopes} scopes.`);
  }

  const scopes: NormalizedScope[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of capture.entries()) {
    const field = `capture[${index}]`;
    if (!isPlainObject(candidate)) return pureFailure(`${field} must be an object.`);
    const hasDirectory = candidate.directory !== undefined;
    const hasFile = candidate.file !== undefined;
    if (typeof candidate.scope !== 'string' || hasDirectory === hasFile) {
      return pureFailure(
        `${field} needs a \`scope\` and exactly one of \`directory\` or \`file\`.`,
      );
    }
    const scope = candidate.scope;
    if (!scopeNamePattern.test(scope)) {
      return pureFailure(`${field}.scope '${scope}' must match ${scopeNamePattern.source}.`);
    }
    if (seen.has(scope)) return pureFailure(`${field}.scope '${scope}' is used twice.`);
    seen.add(scope);

    const kind = hasDirectory ? 'directory' : 'file';
    const rawPath = hasDirectory ? candidate.directory : candidate.file;
    const path = typeof rawPath === 'string' ? normalizeRelativePath(rawPath) : null;
    if (path === null) {
      return pureFailure(
        `${field}.${kind} must be a relative path inside the checkout, got ${JSON.stringify(rawPath)}.`,
      );
    }
    if (hasGitSegment(path)) {
      return pureFailure(`${field}.${kind} '${path}' names Git metadata (.git).`);
    }

    let exclude: string[] = [];
    if (candidate.exclude !== undefined) {
      if (kind === 'file' || !Array.isArray(candidate.exclude)) {
        return pureFailure(`${field}.exclude is only allowed on a directory scope, as an array.`);
      }
      const rawExclusions: readonly unknown[] = candidate.exclude;
      if (rawExclusions.length > checkpointMaxExclusions) {
        return pureFailure(`${field}.exclude has more than ${checkpointMaxExclusions} entries.`);
      }
      const unique = new Set<string>();
      for (const [exclusionIndex, exclusion] of rawExclusions.entries()) {
        const normalized = typeof exclusion === 'string' ? normalizeRelativePath(exclusion) : null;
        if (normalized === null || hasGitSegment(normalized)) {
          return pureFailure(
            `${field}.exclude[${exclusionIndex}] must be a scope-relative path without .git, got ${JSON.stringify(exclusion)}.`,
          );
        }
        unique.add(normalized);
      }
      exclude = [...unique].sort();
    }
    scopes.push({ scope, kind, path, exclude });
  }

  // Two scopes of one plan never nest, so each captured file belongs to exactly one scope.
  for (const [index, a] of scopes.entries()) {
    for (const b of scopes.slice(index + 1)) {
      if (pathContains(a.path, b.path) || pathContains(b.path, a.path)) {
        return pureFailure(
          `Scopes '${a.scope}' and '${b.scope}' overlap ('${a.path}', '${b.path}').`,
        );
      }
    }
  }
  return { ok: true, value: { scopes } };
}

/** `a` contains `b` when they are equal or `b` lies beneath `a`. */
export function pathContains(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * The one spelling of an author's relative path, or null when it is empty, absolute or has a `..`
 * segment anywhere: `a/../b` is refused rather than read as `b`, so a plan always names the path
 * its author wrote. Syntactic only. `/x` and `C:\x` are refused on every platform, so the rule does not change
 * with the machine the runtime runs on.
 */
export function normalizeRelativePath(candidate: string): string | null {
  if (candidate.length === 0 || candidate.includes('\0')) return null;
  if (isAbsolute(candidate) || candidate.startsWith('/') || candidate.startsWith('\\')) return null;
  if (/^[A-Za-z]:/.test(candidate)) return null;
  const slashed = candidate.replaceAll('\\', '/');
  if (slashed.split('/').includes('..')) return null;
  const normalized = posix.normalize(slashed).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') return null;
  return normalized;
}

function hasGitSegment(path: string): boolean {
  return path.split('/').includes('.git');
}
