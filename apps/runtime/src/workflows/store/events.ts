import { and, asc, desc, eq, gt } from 'drizzle-orm';

import type { WorkflowEventCategory, WorkflowEventKind } from '@isagi/contracts';

import { workflowEvents } from '../../persistence/schema.js';
import { now, toNullableJson, type Db, type EventRow } from './rows.js';

/** One append-only event log per run. The same rows are pushed live to clients. */

export interface EventDraft {
  readonly runId: number;
  readonly executionId?: number | null | undefined;
  readonly category: WorkflowEventCategory;
  readonly kind: WorkflowEventKind;
  readonly message: string;
  readonly data?: unknown;
}

export function appendEvent(db: Db, draft: EventDraft): EventRow {
  return db
    .insert(workflowEvents)
    .values({
      runId: draft.runId,
      executionId: draft.executionId ?? null,
      at: now(),
      category: draft.category,
      kind: draft.kind,
      message: draft.message,
      dataJson: toNullableJson(draft.data),
    })
    .returning()
    .get();
}

export function listEvents(
  db: Db,
  query: { readonly runId: number; readonly cursor?: number | undefined; readonly limit: number },
): readonly EventRow[] {
  return db
    .select()
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.runId, query.runId),
        query.cursor === undefined ? undefined : gt(workflowEvents.id, query.cursor),
      ),
    )
    .orderBy(asc(workflowEvents.id))
    .limit(query.limit)
    .all();
}

/** The run's current UI feedback is its latest `ui_feedback` event. */
export function latestUiFeedback(db: Db, runId: number): EventRow | null {
  return (
    db
      .select()
      .from(workflowEvents)
      .where(and(eq(workflowEvents.runId, runId), eq(workflowEvents.kind, 'ui_feedback')))
      .orderBy(desc(workflowEvents.id))
      .get() ?? null
  );
}
