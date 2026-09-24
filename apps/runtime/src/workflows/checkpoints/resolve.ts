/**
 * The checkpoint fold: how one capture becomes an immutable, already-resolved final state.
 *
 * Pure. Resolution runs in three phases around one filesystem step the capture service owns:
 * `applyRegions` replaces regions, the service canonicalizes base and survey paths into the
 * directory-entry vocabulary, and `finishFold` derives absences, warnings, changes and the ordered
 * rows. Nothing here asks the filesystem, so every rule is testable with plain data.
 *
 * The model, stated once:
 *
 * - A **region** is a scope root minus its exclusions. Coverage is a *set* of regions that may
 *   overlap; no region owns a file. `files` is the authority for content; coverage answers only
 *   which base paths may become absences and whether a missing root is an intentional empty
 *   recapture. Every resolved file lies inside some region (`files ⊆ ∪ coverage`).
 * - A new region replaces an inherited one when both have the same scope id (a rebinding of the
 *   same artifact, which may exclude more than before) or when the old region is entirely inside
 *   the new one. An old region the new one only partly covers — because the new one excludes part
 *   of it — survives, so one scope's exclusion never masks another scope's coverage.
 * - Absences come only from this checkpoint's **own** base, for every covered region, inherited or
 *   new. A path at or under a skipped entry (link, special file, nested repository) is never an
 *   absence and never a change: it is left to the baseline and the warning says so.
 * - Region warnings are semantic state that decides absences, so they inherit with their region and
 *   are never truncated. Only `uncaptured_dirty_path` is capped.
 */

import type {
  WorkflowCheckpointChangeOperation,
  WorkflowCheckpointScopeKind,
  WorkflowCheckpointWarningReason,
} from '@isagi/contracts';

import { pathContains, type NormalizedScope } from './plan.js';
import type {
  CanonicalBaseEntry,
  CanonicalDirtyEntry,
  CollectedFile,
  CollectedRegion,
} from './types.js';

export interface Region {
  readonly scopeId: string;
  readonly kind: WorkflowCheckpointScopeKind;
  readonly path: string;
  readonly exclusions: readonly string[];
  /** The key of the checkpoint whose capture produced this coverage. */
  readonly capturedBy: string;
}

export interface ResolvedFile {
  readonly path: string;
  readonly contentRef: string;
  readonly byteSize: number;
  readonly executable: boolean;
}

/** The latest author binding of one scope id, whether or not its region is still active coverage. */
export interface ScopeBinding {
  readonly scopeId: string;
  readonly kind: WorkflowCheckpointScopeKind;
  readonly path: string;
  readonly exclusions: readonly string[];
}

export interface StoredWarning {
  readonly reason: WorkflowCheckpointWarningReason;
  readonly path: string | null;
  readonly scopeId: string | null;
  readonly detail: Readonly<Record<string, string | number>> | null;
  /** The key of the checkpoint whose capture observed it. */
  readonly observedBy: string;
}

export interface ParentResolvedState {
  readonly files: ReadonlyMap<string, ResolvedFile>;
  readonly coverage: readonly Region[];
  /** Region-scoped warnings only; layer warnings are never inherited. */
  readonly regionWarnings: readonly StoredWarning[];
  readonly bindings: ReadonlyMap<string, ScopeBinding>;
}

/** One row of a checkpoint, before the repository mints file keys and assigns `seq` by position. */
export type CheckpointEntry =
  | {
      readonly kind: 'scope';
      readonly scopeId: string;
      readonly scopeKind: WorkflowCheckpointScopeKind;
      readonly path: string;
      readonly exclusions: readonly string[];
      readonly capturedBy: string;
    }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly contentRef: string;
      readonly byteSize: number;
      readonly executable: boolean;
    }
  | { readonly kind: 'absent'; readonly path: string }
  | ({ readonly kind: 'warning' } & StoredWarning)
  | {
      readonly kind: 'change';
      readonly operation: Extract<WorkflowCheckpointChangeOperation, 'delete'>;
      readonly path: string;
    }
  | {
      readonly kind: 'change';
      readonly operation: Exclude<WorkflowCheckpointChangeOperation, 'delete'>;
      readonly path: string;
      readonly contentRef: string;
      readonly byteSize: number;
      readonly executable: boolean;
    };

export interface CheckpointCounts {
  readonly scopes: number;
  readonly files: number;
  readonly absences: number;
  readonly warnings: number;
}

export const uncapturedDirtyPathLimit = 1000;

/** Whether `region` contains root-relative `path`. */
export function regionContains(
  region: Pick<Region, 'kind' | 'path' | 'exclusions'>,
  path: string,
): boolean {
  if (region.kind === 'file') return path === region.path;
  if (!pathContains(region.path, path)) return false;
  return !region.exclusions.some((exclusion) => pathContains(`${region.path}/${exclusion}`, path));
}

/**
 * Whether the new region `next` replaces the inherited region `old`.
 *
 * Same id: a rebinding of one artifact (the capture service has already refused a changed root or
 * kind), so a newly excluded subpath stops being covered. Otherwise only when every path `old`
 * covers is covered by `next`: `next` contains `old`'s root, and every exclusion of `next` that
 * reaches into `old`'s subtree was already excluded by `old`. A file region never replaces a
 * directory region at the same path; that contradiction is reported as a kind conflict instead.
 */
function supersedes(next: Region, old: Region): boolean {
  if (next.scopeId === old.scopeId) return true;
  if (!regionContains(next, old.path)) return false;
  if (old.kind === 'file') return true;
  if (next.kind === 'file') return false;
  return next.exclusions.every((exclusion) => {
    const excluded = `${next.path}/${exclusion}`;
    if (!excluded.startsWith(`${old.path}/`)) return true;
    return old.exclusions.some((own) => pathContains(`${old.path}/${own}`, excluded));
  });
}

/** Byte order of the UTF-8 encoding, so the stored order never depends on UTF-16 code units. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The first plan scope whose id was previously bound to a different root or kind, if any.
 * Exclusions may change; the root and kind are the scope's identity for the whole run.
 */
export function findScopeIdentityChange(
  bindings: ReadonlyMap<string, ScopeBinding>,
  scopes: readonly NormalizedScope[],
): { readonly scope: NormalizedScope; readonly previous: ScopeBinding } | null {
  for (const scope of scopes) {
    const previous = bindings.get(scope.scopeId);
    if (previous && (previous.path !== scope.path || previous.kind !== scope.kind)) {
      return { scope, previous };
    }
  }
  return null;
}

export interface ProvisionalState {
  readonly parent: ParentResolvedState | null;
  /** After region replacement and the orphan sweep. */
  readonly files: ReadonlyMap<string, ResolvedFile>;
  readonly coverage: readonly Region[];
  readonly bindings: ReadonlyMap<string, ScopeBinding>;
  /** Inherited survivors plus this capture's, complete. */
  readonly regionWarnings: readonly StoredWarning[];
  /** `scope_recaptured_empty` so far. */
  readonly layerWarnings: readonly StoredWarning[];
  /** What this capture itself read, by path. */
  readonly collected: ReadonlyMap<string, CollectedFile>;
  readonly thisRegions: readonly Region[];
}

/** Phase 1: region replacement onto the parent's already-resolved state. */
export function applyRegions(input: {
  readonly checkpointKey: string;
  readonly parent: ParentResolvedState | null;
  readonly regions: readonly CollectedRegion[];
}): ProvisionalState {
  const { checkpointKey, parent } = input;
  const files = new Map(parent?.files ?? []);
  let coverage: Region[] = [...(parent?.coverage ?? [])];
  let regionWarnings: StoredWarning[] = [...(parent?.regionWarnings ?? [])];
  const bindings = new Map(parent?.bindings ?? []);
  const layerWarnings: StoredWarning[] = [];
  const collected = new Map<string, CollectedFile>();
  const thisRegions: Region[] = [];

  for (const { scope, absoluteRoot, files: regionFiles, warnings } of input.regions) {
    const region: Region = {
      scopeId: scope.scopeId,
      kind: scope.kind,
      path: scope.path,
      exclusions: scope.exclusions,
      capturedBy: checkpointKey,
    };
    if (absoluteRoot === null) {
      layerWarnings.push({
        reason: 'scope_recaptured_empty',
        path: scope.path,
        scopeId: scope.scopeId,
        detail: null,
        observedBy: checkpointKey,
      });
    }
    for (const path of [...files.keys()]) {
      if (regionContains(region, path)) files.delete(path);
    }
    regionWarnings = regionWarnings.filter(
      (warning) => warning.path === null || !regionContains(region, warning.path),
    );
    coverage = coverage.filter((old) => !supersedes(region, old));

    for (const file of regionFiles) {
      files.set(file.path, {
        path: file.path,
        contentRef: file.contentRef,
        byteSize: file.byteSize,
        executable: file.executable,
      });
      collected.set(file.path, file);
    }
    for (const warning of warnings) {
      regionWarnings.push({
        reason: warning.reason,
        path: warning.path,
        scopeId: warning.scopeId,
        detail: null,
        observedBy: checkpointKey,
      });
    }
    coverage.push(region);
    thisRegions.push(region);
    bindings.set(scope.scopeId, {
      scopeId: scope.scopeId,
      kind: scope.kind,
      path: scope.path,
      exclusions: scope.exclusions,
    });
  }

  // Orphan sweep: a file or skipped entry no remaining region covers is no longer reconstructed,
  // and with no coverage there its base-tracked paths are not absences either — the baseline wins.
  const covered = (path: string) => coverage.some((region) => regionContains(region, path));
  for (const path of [...files.keys()]) if (!covered(path)) files.delete(path);
  regionWarnings = regionWarnings.filter(
    (warning) => warning.path === null || covered(warning.path),
  );

  return {
    parent,
    files,
    coverage,
    bindings,
    regionWarnings,
    layerWarnings,
    collected,
    thisRegions,
  };
}

/** Every proper ancestor of a root-relative path, nearest last. */
function ancestorsOf(path: string): string[] {
  const names = path.split('/');
  return names.slice(1).map((_, index) => names.slice(0, index + 1).join('/'));
}

/**
 * Pairs the final state would need as both a regular file and a directory. Files and absences both
 * name regular files, so one being a proper ancestor of another is a contradiction; so is a file
 * region beside a region at or beneath its path, even when neither holds a file row.
 */
function findKindConflicts(
  coverage: readonly Region[],
  regularFiles: readonly string[],
): [string, string][] {
  const conflicts: [string, string][] = [];
  const fileSet = new Set(regularFiles);
  for (const path of [...fileSet].sort(compareBytes)) {
    for (const ancestor of ancestorsOf(path)) {
      if (fileSet.has(ancestor)) conflicts.push([ancestor, path]);
    }
  }
  const fileRegions = new Set(
    coverage.filter((region) => region.kind === 'file').map((r) => r.path),
  );
  for (const region of coverage) {
    if (region.kind === 'directory' && fileRegions.has(region.path)) {
      conflicts.push([region.path, region.path]);
    }
    for (const ancestor of ancestorsOf(region.path)) {
      if (fileRegions.has(ancestor)) conflicts.push([ancestor, region.path]);
    }
  }
  return conflicts;
}

function compareWarnings(a: StoredWarning, b: StoredWarning): number {
  return compareBytes(a.path ?? '', b.path ?? '') || compareBytes(a.reason, b.reason);
}

export interface FinishedFold {
  /** Scopes, then files and absences interleaved by path, then warnings, then changes. */
  readonly entries: readonly CheckpointEntry[];
  readonly counts: CheckpointCounts;
  /** Non-empty means the capture must fail with `path_kind_conflict`. */
  readonly kindConflicts: readonly (readonly [string, string])[];
}

/** Phase 3: everything after the filesystem has been asked. Every comparison uses authored spelling. */
export function finishFold(input: {
  readonly checkpointKey: string;
  readonly provisional: ProvisionalState;
  /** This checkpoint's own base, canonicalized; `[]` without a commit. */
  readonly base: readonly CanonicalBaseEntry[];
  /** Null for a folder project, which has no survey. */
  readonly survey:
    | { readonly ok: true; readonly entries: readonly CanonicalDirtyEntry[] }
    | { readonly ok: false }
    | null;
  readonly isGitProject: boolean;
}): FinishedFold {
  const { checkpointKey, provisional, base, survey } = input;
  const { files, coverage, regionWarnings, collected, thisRegions, parent } = provisional;

  const skippedPrefixes = regionWarnings.flatMap((warning) =>
    warning.path === null ? [] : [warning.path],
  );
  const underSkipped = (path: string) =>
    skippedPrefixes.some((skipped) => pathContains(skipped, path));
  const inThisRegions = (path: string) =>
    thisRegions.some((region) => regionContains(region, path));

  const absences = base.filter(
    (entry) =>
      coverage.some((region) => regionContains(region, entry.authored)) &&
      !files.has(entry.authored) &&
      !underSkipped(entry.authored),
  );

  const kindConflicts = findKindConflicts(coverage, [
    ...files.keys(),
    ...absences.map((absence) => absence.authored),
  ]);

  // Layer warnings: judged against this capture only, never against inherited rows. An inherited
  // file that is dirty is reported, because this layer did not save its current state.
  const layer: StoredWarning[] = [...provisional.layerWarnings];
  const warn = (reason: WorkflowCheckpointWarningReason, path: string | null = null) =>
    layer.push({ reason, path, scopeId: null, detail: null, observedBy: checkpointKey });
  if (input.isGitProject) warn('ignored_paths_not_surveyed');
  if (survey !== null && !survey.ok) warn('dirty_survey_unavailable');
  const bounded: StoredWarning[] = [];
  if (survey?.ok) {
    const currentAbsences = absences.filter((absence) => inThisRegions(absence.authored));
    for (const entry of survey.entries) {
      const accounted = entry.collapsedDirectory
        ? false
        : collected.has(entry.authored) ||
          currentAbsences.some(
            (absence) => absence.original === entry.original || absence.authored === entry.authored,
          );
      if (!accounted) {
        bounded.push({
          reason: 'uncaptured_dirty_path',
          path: entry.original,
          scopeId: null,
          detail: null,
          observedBy: checkpointKey,
        });
      }
    }
  }
  const kept = bounded.slice(0, uncapturedDirtyPathLimit);
  const omitted = bounded.length - kept.length;
  if (omitted > 0) {
    layer.push({
      reason: 'warnings_truncated',
      path: null,
      scopeId: null,
      detail: { omitted },
      observedBy: checkpointKey,
    });
  }
  // `layer` holds only reasons that are never cut; the dirty paths are the one bounded kind.
  const layerWarnings = [...layer, ...kept];

  // Changes over this checkpoint's regions, in effective-filesystem terms: the prior state is the
  // parent's file where the parent covered the path, otherwise this checkpoint's base entry.
  const baseByAuthored = new Map(base.map((entry) => [entry.authored, entry]));
  const parentCovers = (path: string) =>
    parent?.coverage.some((region) => regionContains(region, path)) ?? false;
  const candidates = new Set<string>();
  for (const path of parent?.files.keys() ?? []) if (inThisRegions(path)) candidates.add(path);
  for (const entry of base) if (inThisRegions(entry.authored)) candidates.add(entry.authored);
  for (const path of collected.keys()) candidates.add(path);
  const changes: Extract<CheckpointEntry, { kind: 'change' }>[] = [];
  for (const path of candidates) {
    // Left to the baseline, like an absence would be: the region warning describes it.
    if (underSkipped(path)) continue;
    const fromParent = parentCovers(path);
    const priorFile = fromParent ? parent?.files.get(path) : undefined;
    const priorBase = fromParent ? undefined : baseByAuthored.get(path);
    const current = collected.get(path);
    if (!current) {
      if (priorFile) changes.push({ kind: 'change', operation: 'delete', path });
      else if (priorBase) {
        changes.push({ kind: 'change', operation: 'delete', path: priorBase.original });
      }
      continue;
    }
    const content = {
      path,
      contentRef: current.contentRef,
      byteSize: current.byteSize,
      executable: current.executable,
    };
    if (!priorFile && !priorBase) {
      changes.push({ kind: 'change', operation: 'add', ...content });
      continue;
    }
    const modified = priorFile
      ? priorFile.contentRef !== current.contentRef || priorFile.executable !== current.executable
      : priorBase!.objectId !== current.objectId || priorBase!.executable !== current.executable;
    if (modified) changes.push({ kind: 'change', operation: 'modify', ...content });
  }

  const scopeRows: CheckpointEntry[] = [...coverage]
    .sort((a, b) => compareBytes(a.path, b.path) || compareBytes(a.scopeId, b.scopeId))
    .map((region) => ({
      kind: 'scope',
      scopeId: region.scopeId,
      scopeKind: region.kind,
      path: region.path,
      exclusions: region.exclusions,
      capturedBy: region.capturedBy,
    }));
  type StateRow = Extract<CheckpointEntry, { kind: 'file' | 'absent' }>;
  const stateRows: StateRow[] = [
    ...[...files.values()].map(
      (file): StateRow => ({
        kind: 'file',
        path: file.path,
        contentRef: file.contentRef,
        byteSize: file.byteSize,
        executable: file.executable,
      }),
    ),
    ...absences.map((absence): StateRow => ({ kind: 'absent', path: absence.original })),
  ].sort((a, b) => compareBytes(a.path, b.path));
  const warningRows: CheckpointEntry[] = [
    ...[...regionWarnings].sort(compareWarnings),
    ...layerWarnings.sort(compareWarnings),
  ].map((warning) => ({ kind: 'warning', ...warning }));
  const changeRows = changes.sort((a, b) => compareBytes(a.path, b.path));

  return {
    entries: [...scopeRows, ...stateRows, ...warningRows, ...changeRows],
    counts: {
      scopes: scopeRows.length,
      files: files.size,
      absences: absences.length,
      warnings: warningRows.length,
    },
    kindConflicts,
  };
}
