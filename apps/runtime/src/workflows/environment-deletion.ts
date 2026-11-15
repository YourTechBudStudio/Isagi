import { Cause, Effect, Layer } from 'effect';

import { EnvironmentDeletionParticipant, type DoomedEnvironment } from '../environment/index.js';
import { InternalEvents, RuntimeEvents } from '../platform/events/index.js';
import { RuntimeDatabase } from '../platform/persistence/index.js';
import { cancelInTransaction, interruptRunningHeadless } from './engine/controls.js';
import { publishCommitted } from './engine/publish.js';
import { appendEvent } from './store/events.js';
import type { Db, EventRow } from './store/rows.js';
import { activeRunStatuses, listRunsIn } from './store/runs.js';

const unfinished: ReadonlySet<string> = new Set(activeRunStatuses);

/**
 * Deleting a surface or worktree's workflow participant (ADR 0008). The deleting service owns the
 * transaction; the workflows domain owns the SQL that ends its runs inside it.
 *
 * Every unfinished run living in what is deleted is cancelled in that transaction, exactly as
 * Cancel would, with the reason on its `run_cancelled` event. A finished run keeps its outcome and
 * is only detached (the delete nulls its `surface_id`, as Dismiss would), but any headless job it
 * still has running ends too: a run that failed after starting one leaves it running. Inside the
 * transaction nothing can launch onto the surface or worktree in between, so a run commits wholly
 * before the delete (and is ended here) or wholly after it (and launch admission refuses it).
 *
 * The follow-up, once the transaction commits, pushes the changes to clients and tells the engine
 * (`workflow_runs_ended_by_deletion`). Stopping the ended headless jobs' processes is the engine's,
 * which owns them in memory: it stops every process whose operation has ended
 * (`stopEndedHeadless`).
 */
export const WorkflowEnvironmentDeletionNoDeps = Layer.effect(
  EnvironmentDeletionParticipant,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const events = yield* RuntimeEvents;
    const internalEvents = yield* InternalEvents;

    const endInTransaction = (db: Db, doomed: DoomedEnvironment): Effect.Effect<void> => {
      const reason = doomed.kind === 'surface' ? 'surface_deleted' : 'worktree_deleted';
      const appended: EventRow[] = [];
      const emit = (draft: Parameters<typeof appendEvent>[1]) => {
        appended.push(appendEvent(db, draft));
      };
      const cancelled: number[] = [];
      const interrupted: number[] = [];
      for (const run of listRunsIn(db, doomed)) {
        if (unfinished.has(run.status)) {
          cancelInTransaction(db, emit, run.id, {
            // Worded for the worktree's teardown, which starts before the delete is certain.
            message:
              doomed.kind === 'surface'
                ? 'Cancelled: its surface was deleted'
                : 'Cancelled: its worktree is being deleted',
            data: { reason },
          });
          cancelled.push(run.id);
        } else if (interruptRunningHeadless(db, emit, run.id) > 0) {
          interrupted.push(run.id);
        }
      }
      if (cancelled.length === 0 && interrupted.length === 0) return Effect.void;
      return Effect.logInfo('Ended workflow work whose environment is being deleted').pipe(
        Effect.annotateLogs({
          reason,
          cancelledWorkflowRunIds: cancelled,
          headlessInterruptedWorkflowRunIds: interrupted,
        }),
        Effect.andThen(
          internalEvents.publish({
            type: 'workflow_runs_ended_by_deletion',
            workflowRunIds: [...cancelled, ...interrupted],
          }),
        ),
        Effect.andThen(
          publishCommitted(database, events, appended, new Set([...cancelled, ...interrupted])),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning('Publishing workflow runs ended by a deletion failed', cause),
        ),
      );
    };

    return EnvironmentDeletionParticipant.of({
      endInTransaction,
      endBeforeTeardown: (doomed) =>
        database
          .transaction('workflow_end_before_teardown', (db) => endInTransaction(db, doomed))
          .pipe(Effect.flatten),
    });
  }),
);

/** The participant with its module dependencies wired by reference, as the composition root uses it. */
export const WorkflowEnvironmentDeletion = WorkflowEnvironmentDeletionNoDeps.pipe(
  Layer.provide([RuntimeEvents.layer, InternalEvents.layer]),
);
