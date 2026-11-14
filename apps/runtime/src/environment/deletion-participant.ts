import { Context, Effect, Layer } from 'effect';

import type { DatabaseError, RuntimeDrizzleDatabase } from '../platform/persistence/index.js';

/**
 * What a delete is about to remove: one surface, or whole worktrees with every surface in them.
 */
export type DoomedEnvironment =
  | { readonly kind: 'surface'; readonly surfaceId: number }
  | { readonly kind: 'worktrees'; readonly worktreeIds: readonly number[] };

/**
 * Port: another module's lifecycles that run inside an environment and must end with it (ADR 0008).
 *
 * The deleting service owns the transaction that removes surfaces or worktrees. A module above it
 * (today: workflows, whose active runs live on a surface and in a worktree) owns the writes that
 * end its own work inside that transaction. The environment cannot import that module,
 * so it names this port and the composition root wires the implementation
 * (`WorkflowEnvironmentDeletion`).
 *
 * Ending the work inside the delete's own transaction is the point: links into the deleted rows
 * are nulled or cascaded by that same commit, so a subscriber to the deletion notifications that
 * follow could no longer find what lived there.
 */
export class EnvironmentDeletionParticipant extends Context.Service<
  EnvironmentDeletionParticipant,
  {
    /**
     * Runs inside the deleting transaction (a better-sqlite3 synchronous callback), before any row
     * is removed, even when the delete then finds nothing to remove. A throw rolls back the whole
     * delete.
     *
     * Returns the participant's follow-up, which the deleter runs once the transaction has
     * committed, and never when it rolled back. The follow-up does not fail: it only announces
     * what the transaction already wrote.
     */
    readonly endInTransaction: (
      db: RuntimeDrizzleDatabase,
      doomed: DoomedEnvironment,
    ) => Effect.Effect<void>;
    /**
     * The same ending in its own transaction, follow-up included, for a delete that tears down
     * processes before its rows go (worktree delete stops agents and terminals, then removes the
     * checkout, then the rows). Called before that teardown, so the work is ended by the delete
     * rather than failed by the teardown it would otherwise observe; the delete still calls
     * `endInTransaction` when it removes the rows, for work that began in between.
     */
    readonly endBeforeTeardown: (doomed: DoomedEnvironment) => Effect.Effect<void, DatabaseError>;
  }
>()('isagi/runtime/environment/EnvironmentDeletionParticipant') {
  /** For tests of a deleting module that has no dependent lifecycles to end. */
  static readonly none = Layer.succeed(
    EnvironmentDeletionParticipant,
    EnvironmentDeletionParticipant.of({
      endInTransaction: () => Effect.void,
      endBeforeTeardown: () => Effect.void,
    }),
  );
}
