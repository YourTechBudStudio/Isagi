import { and, eq, inArray, isNull, type InferSelectModel, type SQL } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { EditorAttemptFailureReason } from '@isagi/contracts';

import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDrizzleDatabase,
} from '../persistence/index.js';
import { editorContexts, ptyProcesses } from '../persistence/schema.js';
import { editorContextRow } from './row-mapper.js';
import type { EditorContextRow, EditorIncarnationHandoff } from './types.js';

type EditorContextRecord = InferSelectModel<typeof editorContexts>;
type PtyProcessRecord = InferSelectModel<typeof ptyProcesses>;
type JoinedEditorContext = { context: EditorContextRecord; process: PtyProcessRecord | null };

/**
 * What a guarded transition did. `context_missing` is a real outcome, not a
 * bug: a worktree deletion cascades this row away, and a launch already in
 * flight can reach the repository afterwards. Callers converge on it instead of
 * assuming their write landed.
 *
 * There is deliberately no third "rejected" member. A transition whose row
 * exists but whose precondition does not hold is a sequencing defect, and it
 * dies as `EditorContextTransitionRejected` rather than becoming an outcome
 * every caller has to pretend it can recover from.
 */
export type EditorContextTransitionOutcome = 'applied' | 'context_missing';

/**
 * Raised when a transition's precondition did not hold on the persisted row.
 * It is the write-side twin of `EditorContextRowInvariantViolation`: that one
 * catches an impossible row on read, this one refuses to create it. Both are
 * defects, so both escape as such — this is raised *outside* `RuntimeDatabase`,
 * because inside it `Effect.try` would deliver a lifecycle bug as an ordinary
 * `DatabaseError`.
 */
export class EditorContextTransitionRejected extends Error {
  constructor(
    readonly editorContextId: number,
    readonly transition: string,
    readonly precondition: string,
  ) {
    super(
      `Editor context ${editorContextId} cannot ${transition}: it requires that ${precondition}.`,
    );
    this.name = 'EditorContextTransitionRejected';
  }
}

/**
 * The durable editor context's storage. It owns the pointer to the current
 * process incarnation, the endpoint that incarnation was reached at, and the
 * record of the launch attempt in flight or last failed.
 *
 * Every state change below is one SQL statement with one timestamp. That is not
 * an optimization: it is what makes "the pointer and the attempt never
 * disagree" a property of the storage rather than a promise about how callers
 * sequence two writes.
 *
 * Each transition also carries its precondition in its own `WHERE` clause and
 * requires exactly one affected row. That is what makes the invariants a
 * property of the storage rather than of the call order: a transition can only
 * commit from a state it is legal to commit from. Zero affected rows is then
 * decided, not ignored — a vanished row is reported as `context_missing`, a
 * surviving row that refused the guard is a defect.
 *
 * This package deliberately knows nothing about surfaces or panes. Placement is
 * a surfaces fact, and the surfaces repository reads editor rows through the
 * shared mapper; the edge never runs the other way.
 */
export interface EditorContextRepositoryService {
  readonly findByWorktree: (
    worktreeId: number,
  ) => Effect.Effect<EditorContextRow | null, DatabaseError>;
  readonly find: (editorContextId: number) => Effect.Effect<EditorContextRow | null, DatabaseError>;
  readonly findByActivePtyProcessId: (
    ptyProcessId: number,
  ) => Effect.Effect<EditorContextRow | null, DatabaseError>;
  readonly listForIds: (ids: readonly number[]) => Effect.Effect<EditorContextRow[], DatabaseError>;
  /**
   * Insert with `attempt: none`, no pointer, no endpoint. Concurrent inserts
   * for one worktree are prevented by the per-worktree lock the caller holds;
   * the unique index is the backstop. A `SQLITE_CONSTRAINT_UNIQUE` therefore
   * surfaces as a `DatabaseError` and means the lock was bypassed — there is
   * deliberately no upsert and no find-after-conflict fallback, because
   * recovering silently would hide exactly the bug worth seeing.
   */
  readonly create: (input: {
    readonly worktreeId: number;
  }) => Effect.Effect<EditorContextRow, DatabaseError>;
  /**
   * Transition 1. Guarded on the context holding no incarnation, which is what
   * makes "pointer and endpoint are already null" invariant 2 rather than a
   * caller's habit: opening an attempt on an owned context cannot commit.
   */
  readonly markAttemptInProgress: (
    editorContextId: number,
  ) => Effect.Effect<EditorContextTransitionOutcome, DatabaseError>;
  /**
   * Transition 2. Clears pointer, endpoint, and socket *and* opens the attempt
   * in one statement. Used only by a replacement, only after an affirmative
   * termination, so ownership is never dropped on an uncertain predecessor.
   */
  readonly clearIncarnationAndMarkInProgress: (
    editorContextId: number,
  ) => Effect.Effect<EditorContextTransitionOutcome, DatabaseError>;
  /**
   * Transition 3, the handoff: pointer, endpoint, and socket set and the
   * attempt closed, in one statement. Committed before the process starts, so
   * a crash between commit and start leaves an owned row rather than an
   * unowned live process.
   *
   * Guarded on an unowned context with an attempt in progress — the only state
   * transitions 1 and 2 leave behind. Ownership therefore cannot be installed
   * over ownership, and a caller that skipped opening its attempt finds out
   * here rather than by silently starting a process the row never claimed.
   */
  readonly installIncarnation: (input: {
    readonly editorContextId: number;
    readonly handoff: EditorIncarnationHandoff;
  }) => Effect.Effect<EditorContextTransitionOutcome, DatabaseError>;
  /**
   * Transition 4. Pointer and endpoint are left exactly as they are, which is
   * what lets a refused replacement report both a live incarnation and a failed
   * attempt. Any reason recorded while a pointer is retained must therefore be
   * `previous_incarnation_not_stopped`, so every other reason is guarded on an
   * unowned context: the combination the row mapper rejects on read cannot be
   * written in the first place.
   */
  readonly markAttemptFailed: (input: {
    readonly editorContextId: number;
    readonly reason: EditorAttemptFailureReason;
    readonly detail: string | null;
  }) => Effect.Effect<EditorContextTransitionOutcome, DatabaseError>;
  /** Transition 5. Pointer, endpoint, socket cleared and the attempt reset. */
  readonly clearIncarnation: (
    editorContextId: number,
  ) => Effect.Effect<EditorContextTransitionOutcome, DatabaseError>;
  /**
   * Boot convergence: an attempt that was in flight when the runtime stopped
   * can never resume, so every `in_progress` row becomes
   * `failed{launch_interrupted}`. By invariant 2 none of them holds a pointer,
   * which is what makes this sweep safe without inspecting processes. Returns
   * the affected ids so the caller can publish one change each.
   */
  readonly failInterruptedAttempts: Effect.Effect<number[], DatabaseError>;
}

export const EditorContextRepository = Context.GenericTag<EditorContextRepositoryService>(
  'isagi/EditorContextRepository',
);

export const EditorContextRepositoryLive = Layer.effect(
  EditorContextRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;

    // Decoding runs outside `database.use` on purpose. `use` wraps its body in
    // `Effect.try`, so a mapper throw raised inside it would be converted into
    // a `DatabaseError` — an impossible persisted row would be reported to the
    // user as an ordinary database fault. Mapping here keeps it a defect.
    const decodeOne = (row: JoinedEditorContext | undefined) =>
      row ? editorContextRow(row.context, row.process) : null;

    const selectJoined = (db: RuntimeDrizzleDatabase) =>
      db
        .select({ context: editorContexts, process: ptyProcesses })
        .from(editorContexts)
        .leftJoin(ptyProcesses, eq(editorContexts.activePtyProcessId, ptyProcesses.id));

    /**
     * One guarded transition. The precondition rides in the same `WHERE` as the
     * id, so the check and the write cannot be separated by another writer, and
     * the affected-row count is the answer: one row means the guard held.
     *
     * Zero rows is ambiguous on its own, so the same transaction asks which
     * kind of zero it was. That re-read is the only reason these run in a
     * transaction rather than a bare statement.
     */
    const transition = (input: {
      readonly editorContextId: number;
      readonly operation: string;
      readonly transitionName: string;
      readonly precondition?:
        | { readonly clause: SQL | undefined; readonly describedAs: string }
        | undefined;
      readonly values: Partial<typeof editorContexts.$inferInsert>;
    }) =>
      database
        .transaction(input.operation, (db) => {
          const matchesId = eq(editorContexts.id, input.editorContextId);
          const changes = db
            .update(editorContexts)
            .set(input.values)
            // `and` drops an undefined operand, so an unguarded transition
            // narrows to the id alone without a second code path.
            .where(and(matchesId, input.precondition?.clause))
            .run().changes;
          if (changes === 1) return { applied: true as const };
          const survivor = db
            .select({ id: editorContexts.id })
            .from(editorContexts)
            .where(matchesId)
            .get();
          return {
            applied: false as const,
            // A surviving row means the guard, not the row, refused the write.
            refusedPrecondition: survivor ? (input.precondition?.describedAs ?? null) : null,
          };
        })
        .pipe(
          // Outside `use`/`transaction` on purpose: a defect raised inside would
          // be caught by `Effect.try` and reported as a `DatabaseError`.
          Effect.flatMap((result): Effect.Effect<EditorContextTransitionOutcome> => {
            if (result.applied) return Effect.succeed('applied');
            if (result.refusedPrecondition === null) return Effect.succeed('context_missing');
            return Effect.die(
              new EditorContextTransitionRejected(
                input.editorContextId,
                input.transitionName,
                result.refusedPrecondition,
              ),
            );
          }),
        );

    const holdsNoIncarnation = {
      clause: isNull(editorContexts.activePtyProcessId),
      describedAs: 'the context holds no incarnation',
    };

    return {
      findByWorktree: (worktreeId) =>
        database
          .use('find_editor_context_by_worktree', (db) =>
            selectJoined(db).where(eq(editorContexts.worktreeId, worktreeId)).get(),
          )
          .pipe(Effect.map(decodeOne)),
      find: (editorContextId) =>
        database
          .use('find_editor_context', (db) =>
            selectJoined(db).where(eq(editorContexts.id, editorContextId)).get(),
          )
          .pipe(Effect.map(decodeOne)),
      findByActivePtyProcessId: (ptyProcessId) =>
        database
          .use('find_editor_context_by_active_process', (db) =>
            selectJoined(db).where(eq(editorContexts.activePtyProcessId, ptyProcessId)).get(),
          )
          .pipe(Effect.map(decodeOne)),
      listForIds: (ids) =>
        // An empty `IN ()` is not portable SQL and Drizzle's handling of it is
        // not a contract worth depending on; the caller's empty case is
        // answered here.
        ids.length === 0
          ? Effect.succeed([])
          : database
              .use('list_editor_contexts_for_ids', (db) =>
                selectJoined(db)
                  .where(inArray(editorContexts.id, [...ids]))
                  .all(),
              )
              .pipe(
                Effect.map((rows) => rows.map((row) => editorContextRow(row.context, row.process))),
              ),
      create: (input) =>
        database
          .use('create_editor_context', (db) => {
            const now = timestamp();
            return db
              .insert(editorContexts)
              .values({
                worktreeId: input.worktreeId,
                activePtyProcessId: null,
                endpointHost: null,
                endpointPort: null,
                sessionSocketPath: null,
                attemptState: 'none',
                attemptReason: null,
                attemptDetail: null,
                attemptStartedAt: null,
                createdAt: now,
                updatedAt: now,
              })
              .returning()
              .get();
          })
          .pipe(Effect.map((record) => editorContextRow(record, null))),
      markAttemptInProgress: (editorContextId) => {
        const now = timestamp();
        return transition({
          editorContextId,
          operation: 'mark_editor_attempt_in_progress',
          transitionName: 'open a launch attempt',
          precondition: holdsNoIncarnation,
          values: {
            attemptState: 'in_progress',
            attemptReason: null,
            attemptDetail: null,
            attemptStartedAt: now,
            updatedAt: now,
          },
        });
      },
      clearIncarnationAndMarkInProgress: (editorContextId) => {
        const now = timestamp();
        // No precondition beyond the row existing: this transition's whole
        // purpose is to move an owned context to an unowned in-flight one, and
        // running it on an already-idle context is a replacement of nothing.
        return transition({
          editorContextId,
          operation: 'clear_editor_incarnation_and_mark_in_progress',
          transitionName: 'release its incarnation and open a launch attempt',
          values: {
            activePtyProcessId: null,
            endpointHost: null,
            endpointPort: null,
            sessionSocketPath: null,
            attemptState: 'in_progress',
            attemptReason: null,
            attemptDetail: null,
            attemptStartedAt: now,
            updatedAt: now,
          },
        });
      },
      installIncarnation: (input) =>
        transition({
          editorContextId: input.editorContextId,
          operation: 'install_editor_incarnation',
          transitionName: 'install an incarnation',
          precondition: {
            clause: and(
              isNull(editorContexts.activePtyProcessId),
              eq(editorContexts.attemptState, 'in_progress'),
            ),
            describedAs: 'the context holds no incarnation and has an attempt in progress',
          },
          values: {
            activePtyProcessId: input.handoff.ptyProcessId,
            endpointHost: input.handoff.endpointHost,
            endpointPort: input.handoff.endpointPort,
            sessionSocketPath: input.handoff.sessionSocketPath,
            attemptState: 'none',
            attemptReason: null,
            attemptDetail: null,
            attemptStartedAt: null,
            updatedAt: timestamp(),
          },
        }),
      markAttemptFailed: (input) =>
        transition({
          editorContextId: input.editorContextId,
          operation: 'mark_editor_attempt_failed',
          transitionName: `record a ${input.reason} failure`,
          // The one reason that may stand beside a retained pointer is the one
          // a refused replacement records; every other reason would compose a
          // row the mapper rejects, so it is guarded out at the write.
          precondition:
            input.reason === 'previous_incarnation_not_stopped' ? undefined : holdsNoIncarnation,
          values: {
            attemptState: 'failed',
            attemptReason: input.reason,
            attemptDetail: input.detail,
            attemptStartedAt: null,
            updatedAt: timestamp(),
          },
        }),
      clearIncarnation: (editorContextId) =>
        transition({
          editorContextId,
          operation: 'clear_editor_incarnation',
          transitionName: 'return to idle',
          values: {
            activePtyProcessId: null,
            endpointHost: null,
            endpointPort: null,
            sessionSocketPath: null,
            attemptState: 'none',
            attemptReason: null,
            attemptDetail: null,
            attemptStartedAt: null,
            updatedAt: timestamp(),
          },
        }),
      failInterruptedAttempts: database.use('fail_interrupted_editor_attempts', (db) =>
        db
          .update(editorContexts)
          .set({
            attemptState: 'failed',
            attemptReason: 'launch_interrupted',
            attemptDetail: null,
            attemptStartedAt: null,
            updatedAt: timestamp(),
          })
          .where(eq(editorContexts.attemptState, 'in_progress'))
          .returning({ id: editorContexts.id })
          .all()
          .map((row) => row.id),
      ),
    } satisfies EditorContextRepositoryService;
  }),
);

function timestamp() {
  return new Date().toISOString();
}
