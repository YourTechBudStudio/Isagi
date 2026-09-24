/**
 * Normalization of the plan a checkpoint's `prepare` returned.
 *
 * Pure and synchronous: it runs after `prepare` and before anything touches the filesystem, so an
 * author mistake fails the segment with `checkpoint_prepare_failed` and a named reason while no
 * byte has been published. The value arriving here has already passed the serializability gate
 * but is otherwise untrusted — authors write plans in plain JavaScript as often as TypeScript.
 *
 * Every rule refuses rather than repairs, the posture evidence already takes: a silently trimmed
 * scope list or a dropped exclusion would save something other than what the author asked for.
 */

import { normalizeWorktreeRelativePath } from '../paths.js';

export type CheckpointPlanRejectionReason =
  | 'invalid_plan_shape'
  | 'invalid_title'
  | 'too_many_scopes'
  | 'invalid_scope_shape'
  | 'invalid_scope_id'
  | 'duplicate_scope_id'
  | 'invalid_scope_path'
  | 'git_metadata_path'
  | 'too_many_exclusions'
  | 'invalid_exclusion'
  | 'overlapping_scopes';

export interface NormalizedScope {
  readonly scopeId: string;
  readonly kind: 'directory' | 'file';
  /** Normalized root-relative path. */
  readonly path: string;
  /** Normalized scope-relative paths, sorted and deduplicated; `[]` for file scopes. */
  readonly exclusions: readonly string[];
}

export interface NormalizedCheckpointPlan {
  readonly title: string;
  /** Sorted by `path`, so every downstream order is deterministic. */
  readonly scopes: readonly NormalizedScope[];
}

export type PlanResult =
  | { readonly ok: true; readonly value: NormalizedCheckpointPlan }
  | {
      readonly ok: false;
      readonly reason: CheckpointPlanRejectionReason;
      readonly detail: {
        readonly scopeId?: string;
        readonly field?: string;
        readonly path?: string;
      };
    };

export const checkpointTitleMaxLength = 512;
export const checkpointMaxScopes = 64;
export const checkpointMaxExclusions = 64;
/** The workflow-identifier grammar evidence roles already use. */
const scopeIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasGitSegment(path: string): boolean {
  return path.split('/').includes('.git');
}

/** `a` contains `b` when they are equal or `b` lies beneath `a`. */
export function pathContains(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer}/`);
}

export function normalizeCheckpointPlan(
  value: unknown,
  node: { readonly nodeId: string; readonly title?: string | undefined },
): PlanResult {
  const reject = (
    reason: CheckpointPlanRejectionReason,
    detail: { scopeId?: string; field?: string; path?: string } = {},
  ): PlanResult => ({ ok: false, reason, detail });

  if (!isPlainObject(value) || !Array.isArray(value.capture)) {
    return reject('invalid_plan_shape', { field: 'capture' });
  }

  // The default chain is held to the same bound: a static title too long to store is refused as
  // clearly as a returned one, never cut short.
  const rawTitle = value.title === undefined ? node.title?.trim() || node.nodeId : value.title;
  if (typeof rawTitle !== 'string') return reject('invalid_title', { field: 'title' });
  const title = rawTitle.trim();
  if (title.length === 0 || title.length > checkpointTitleMaxLength) {
    return reject('invalid_title', { field: 'title' });
  }

  const capture: readonly unknown[] = value.capture;
  if (capture.length > checkpointMaxScopes) return reject('too_many_scopes', { field: 'capture' });

  const scopes: NormalizedScope[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of capture.entries()) {
    const field = `capture[${index}]`;
    if (!isPlainObject(candidate)) return reject('invalid_scope_shape', { field });
    const hasDirectory = candidate.directory !== undefined;
    const hasFile = candidate.file !== undefined;
    if (typeof candidate.scope !== 'string' || hasDirectory === hasFile) {
      return reject('invalid_scope_shape', { field });
    }
    const scopeId = candidate.scope;
    if (!scopeIdPattern.test(scopeId)) return reject('invalid_scope_id', { scopeId, field });
    if (seen.has(scopeId)) return reject('duplicate_scope_id', { scopeId, field });
    seen.add(scopeId);

    const kind = hasDirectory ? 'directory' : 'file';
    const rawPath = hasDirectory ? candidate.directory : candidate.file;
    if (typeof rawPath !== 'string') {
      return reject('invalid_scope_shape', { scopeId, field: `${field}.${kind}` });
    }
    const normalized = normalizeWorktreeRelativePath(rawPath);
    if (!normalized.ok) {
      return reject('invalid_scope_path', { scopeId, field: `${field}.${kind}`, path: rawPath });
    }
    if (hasGitSegment(normalized.path)) {
      return reject('git_metadata_path', {
        scopeId,
        field: `${field}.${kind}`,
        path: normalized.path,
      });
    }

    let exclusions: string[] = [];
    if (candidate.exclude !== undefined) {
      if (kind === 'file' || !Array.isArray(candidate.exclude)) {
        return reject('invalid_scope_shape', { scopeId, field: `${field}.exclude` });
      }
      const rawExclusions: readonly unknown[] = candidate.exclude;
      if (rawExclusions.length > checkpointMaxExclusions) {
        return reject('too_many_exclusions', { scopeId, field: `${field}.exclude` });
      }
      const unique = new Set<string>();
      for (const [exclusionIndex, exclusion] of rawExclusions.entries()) {
        const exclusionField = `${field}.exclude[${exclusionIndex}]`;
        const normalizedExclusion =
          typeof exclusion === 'string' ? normalizeWorktreeRelativePath(exclusion) : null;
        if (!normalizedExclusion?.ok || hasGitSegment(normalizedExclusion.path)) {
          return reject('invalid_exclusion', {
            scopeId,
            field: exclusionField,
            ...(typeof exclusion === 'string' ? { path: exclusion } : {}),
          });
        }
        unique.add(normalizedExclusion.path);
      }
      exclusions = [...unique].sort();
    }
    scopes.push({ scopeId, kind, path: normalized.path, exclusions });
  }

  // Literal roots, deliberately ignoring exclusions: two scopes of one plan never nest, so each
  // collected file has exactly one scope and the fold never has to rank regions within a layer.
  for (const [index, a] of scopes.entries()) {
    for (const b of scopes.slice(index + 1)) {
      if (pathContains(a.path, b.path) || pathContains(b.path, a.path)) {
        return reject('overlapping_scopes', { scopeId: b.scopeId, path: b.path });
      }
    }
  }

  scopes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, value: { title, scopes } };
}
