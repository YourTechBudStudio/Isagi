/**
 * Checkpoint plans: what one visit to a checkpoint node saves.
 *
 * A checkpoint's `prepare` returns a plan. The runtime captures the declared scopes from the run's
 * destination root, records that visit's Git commit when one exists, and folds the result onto the
 * run's previous checkpoint, so a scope the plan omits keeps whatever an earlier checkpoint saved
 * for it. Omitting a scope never means "delete it".
 *
 * The one authoring rule that matters: a scope id names one artifact or region for the whole run.
 * A later visit that reuses the id must name the same root and kind; only its exclusions may
 * change. To capture a different root, use a different id.
 */

export interface CheckpointPlan {
  /** Instance title. Defaults to the node's `title`, then its id. Trimmed, non-empty, ≤ 512 chars. */
  readonly title?: string | undefined;
  /**
   * Zero or more scopes; at most 64, and no two may overlap. An empty plan records the automatic
   * baseline and inherits every previously covered region.
   */
  readonly capture: readonly CheckpointScope[];
}

export type CheckpointScope = CheckpointDirectoryScope | CheckpointFileScope;

export interface CheckpointDirectoryScope {
  /**
   * Stable artifact or region identity, `/^[a-z0-9][a-z0-9._-]{0,63}$/`, unique within the plan;
   * later visits keep this root and kind.
   */
  readonly scope: string;
  /** Destination-root-relative directory. */
  readonly directory: string;
  /** Scope-relative files or directories to leave out; at most 64; no globs. */
  readonly exclude?: readonly string[] | undefined;
}

export interface CheckpointFileScope {
  /** Stable artifact identity; later visits keep this file path and kind. */
  readonly scope: string;
  /** Destination-root-relative regular file. */
  readonly file: string;
}
