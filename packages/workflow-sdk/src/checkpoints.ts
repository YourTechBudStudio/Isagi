/**
 * Checkpoint plans: what one visit to a checkpoint node saves.
 *
 * A checkpoint's `prepare` returns a plan. The runtime records the destination's current Git commit
 * (none for a folder project or a repository with no commits yet) and an exact copy of exactly the
 * scopes the plan names. Nothing is inherited from earlier checkpoints: a scope the plan omits is
 * simply not part of this checkpoint, so capture everything a rebuild needs. A scope whose path does
 * not exist is recorded as missing, and exporting the checkpoint makes it absent.
 *
 * `scope` is a stable name for listing and comparing snapshots of the same thing across visits (for
 * example every `plan` snapshot of a run).
 */

export interface CheckpointPlan {
  /** Instance title. Defaults to the node's `title`, then its id. Trimmed, non-empty, ≤ 512 chars. */
  readonly title?: string | undefined;
  /**
   * Zero or more scopes; at most 64, and no two may overlap. An empty plan records only the commit.
   */
  readonly capture: readonly CheckpointScope[];
}

export type CheckpointScope = CheckpointDirectoryScope | CheckpointFileScope;

export interface CheckpointDirectoryScope {
  /** Stable name for this snapshot, `/^[a-z0-9][a-z0-9._-]{0,63}$/`, unique within the plan. */
  readonly scope: string;
  /** Destination-root-relative directory. */
  readonly directory: string;
  /** Scope-relative files or directories to leave out; at most 64; no globs. */
  readonly exclude?: readonly string[] | undefined;
}

export interface CheckpointFileScope {
  /** Stable name for this snapshot, unique within the plan. */
  readonly scope: string;
  /** Destination-root-relative regular file. */
  readonly file: string;
}
