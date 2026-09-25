import type { WorkflowCheckpointInventoryEntry } from '@isagi/contracts';

/**
 * Turning a resolved inventory into what export writes: pure, so every rule is testable alone.
 *
 * Files and absences are root-relative paths under the export root. Scopes and warnings describe
 * coverage; they are carried for the result and never change the destination.
 */

type Entry = WorkflowCheckpointInventoryEntry;
export type FileEntry = Extract<Entry, { readonly kind: 'file' }>;
export type AbsentEntry = Extract<Entry, { readonly kind: 'absent' }>;
export type ScopeEntry = Extract<Entry, { readonly kind: 'scope' }>;
export type WarningEntry = Extract<Entry, { readonly kind: 'warning' }>;

export interface ExportPlan {
  readonly files: readonly FileEntry[];
  readonly absences: readonly AbsentEntry[];
  readonly scopes: readonly ScopeEntry[];
  readonly warnings: readonly WarningEntry[];
}

/**
 * Why an inventory cannot be applied. `unsafe_path` is `export_path_unsafe`; every other kind is
 * `export_inventory_conflict`.
 */
export type InventoryProblem =
  | { readonly kind: 'unsafe_path'; readonly path: string; readonly rule: UnsafePathRule }
  | { readonly kind: 'duplicate_file'; readonly path: string }
  | { readonly kind: 'file_and_absence'; readonly path: string }
  | { readonly kind: 'file_is_directory_prefix'; readonly path: string; readonly other: string }
  | { readonly kind: 'folding_collision'; readonly path: string; readonly other: string };

export type UnsafePathRule = 'empty' | 'nul' | 'absolute' | 'bad_segment' | 'git_directory';

export type PlanOutcome =
  | { readonly ok: true; readonly plan: ExportPlan }
  | { readonly ok: false; readonly problem: InventoryProblem };

export function planExport(entries: readonly Entry[]): PlanOutcome {
  const files: FileEntry[] = [];
  const absences: AbsentEntry[] = [];
  const scopes: ScopeEntry[] = [];
  const warnings: WarningEntry[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case 'file':
        files.push(entry);
        break;
      case 'absent':
        absences.push(entry);
        break;
      case 'scope':
        scopes.push(entry);
        break;
      case 'warning':
        warnings.push(entry);
        break;
    }
  }

  for (const entry of [...files, ...absences]) {
    const rule = unsafePathRule(entry.path);
    if (rule !== null) return fail({ kind: 'unsafe_path', path: entry.path, rule });
  }

  const filePaths = new Set<string>();
  for (const file of files) {
    if (filePaths.has(file.path)) return fail({ kind: 'duplicate_file', path: file.path });
    filePaths.add(file.path);
  }
  for (const absence of absences) {
    if (filePaths.has(absence.path)) return fail({ kind: 'file_and_absence', path: absence.path });
  }

  // A file that is also a directory of another file cannot both be written. Checked on exact paths
  // first, so the plainer problem is the one reported.
  const prefix = directoryPrefixConflict([...filePaths]);
  if (prefix !== null) return fail({ kind: 'file_is_directory_prefix', ...prefix });

  // R6: on a case-insensitive or normalizing filesystem, two file targets that fold together would
  // silently overwrite each other (or one would become the other's directory), so both relations are
  // refused on the folded form too. Absences are applied before any file, so an absence folding onto
  // a file cannot remove it and is allowed.
  const folded = new Map<string, string>();
  for (const path of filePaths) {
    const key = fold(path);
    const other = folded.get(key);
    if (other !== undefined) return fail({ kind: 'folding_collision', path, other });
    folded.set(key, path);
  }
  const foldedPrefix = directoryPrefixConflict([...folded.keys()]);
  if (foldedPrefix !== null) {
    return fail({
      kind: 'folding_collision',
      path: folded.get(foldedPrefix.path)!,
      other: folded.get(foldedPrefix.other)!,
    });
  }

  return { ok: true, plan: { files, absences, scopes, warnings } };
}

/**
 * A path is safe when it is non-empty, has no NUL, is relative, splits on `/` into segments none of
 * which is empty, `.` or `..`, and never names `.git` in any letter case: writing there would
 * corrupt the exported worktree's link to its repository.
 */
export function unsafePathRule(path: string): UnsafePathRule | null {
  if (path.length === 0) return 'empty';
  if (path.includes('\0')) return 'nul';
  if (path.startsWith('/')) return 'absolute';
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'bad_segment';
    if (segment.toLowerCase() === '.git') return 'git_directory';
  }
  return null;
}

function fold(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/** One path that is a directory of another path in the set, if any. */
function directoryPrefixConflict(
  paths: readonly string[],
): { readonly path: string; readonly other: string } | null {
  const set = new Set(paths);
  for (const path of paths) {
    const segments = path.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const directory = segments.slice(0, length).join('/');
      if (set.has(directory)) return { path: directory, other: path };
    }
  }
  return null;
}

function fail(problem: InventoryProblem): PlanOutcome {
  return { ok: false, problem };
}
