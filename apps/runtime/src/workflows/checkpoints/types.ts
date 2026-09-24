/**
 * Plain data exchanged between checkpoint collection, Git inspection and the pure fold.
 *
 * Declared apart from the modules that produce them so the fold can be written and tested as pure
 * code against plain values, without importing anything that touches a disk or a subprocess.
 */

import type { WorkflowCheckpointRegionWarningReason } from '@isagi/contracts';

import type { NormalizedScope } from './plan.js';

/** One regular file a capture read and published. Paths are root-relative directory-entry spellings. */
export interface CollectedFile {
  readonly path: string;
  /** `sha256:<64 hex>` from the content store. */
  readonly contentRef: string;
  readonly byteSize: number;
  readonly executable: boolean;
  /** The Git blob object id of the captured bytes, for change classification only; null in a folder project. */
  readonly objectId: string | null;
}

/** An entry inside a region that collection saw and deliberately did not capture. */
export interface RegionWarning {
  readonly reason: WorkflowCheckpointRegionWarningReason;
  readonly path: string;
  readonly scopeId: string;
}

/** One scope after collection. `absoluteRoot` is null for an intentional empty recapture. */
export interface CollectedRegion {
  readonly scope: NormalizedScope;
  readonly absoluteRoot: string | null;
  readonly files: readonly CollectedFile[];
  readonly warnings: readonly RegionWarning[];
}

/** A regular-file entry (`100644`/`100755`) of the checkpoint's own base tree. */
export interface BaseTreeEntry {
  readonly path: string;
  readonly objectId: string;
  readonly executable: boolean;
}

/** One `git status` entry. A collapsed untracked directory ends the survey's knowledge at that level. */
export interface DirtyEntry {
  readonly path: string;
  readonly collapsedDirectory: boolean;
}

/**
 * A base or survey path after canonicalization: `original` is the spelling Git used, `authored` the
 * spelling in the directory-entry vocabulary the inventory uses. They differ only when an existing
 * entry is spelled otherwise on disk.
 */
export interface CanonicalPath {
  readonly original: string;
  readonly authored: string;
}

export type CanonicalBaseEntry = Omit<BaseTreeEntry, 'path'> & CanonicalPath;
export type CanonicalDirtyEntry = Omit<DirtyEntry, 'path'> & CanonicalPath;
