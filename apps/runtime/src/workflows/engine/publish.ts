import { Effect } from 'effect';

import { nextRuntimeEventEnvelope, type RuntimeEvents } from '../../platform/events/index.js';
import type { RuntimeDatabase } from '../../platform/persistence/index.js';
import { eventDto, runSummaryById } from '../read/mappers.js';
import type { EventRow } from '../store/rows.js';

/**
 * Pushes what a committed write appended: each event, then the new summary of every run it touched
 * or `changedRuns` names. A run that no longer exists has no summary and is skipped.
 *
 * The engine's `commit` publishes through this, and so does every other writer of the workflow
 * tables (`environment-deletion.ts`), so clients see one shape whoever wrote.
 */
export function publishCommitted(
  database: RuntimeDatabase['Service'],
  events: RuntimeEvents['Service'],
  rows: readonly EventRow[],
  changedRuns: ReadonlySet<number>,
) {
  return Effect.gen(function* () {
    for (const row of rows) {
      yield* events.publish({
        ...nextRuntimeEventEnvelope(),
        type: 'workflow_run_event',
        payload: eventDto(row),
      });
    }
    for (const runId of new Set([...rows.map((row) => row.runId), ...changedRuns])) {
      const summary = yield* database.use('workflow_read_summary', (db) =>
        runSummaryById(db, runId),
      );
      if (summary) {
        yield* events.publish({
          ...nextRuntimeEventEnvelope(),
          type: 'workflow_run_changed',
          payload: summary,
        });
      }
    }
  });
}
