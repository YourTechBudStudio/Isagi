import { Context, Layer } from 'effect';

import type { RuntimeDrizzleDatabase } from '../persistence/index.js';
import { deleteRunsOfProject } from './store/runs.js';

/**
 * Project deletion's workflow participant. The workspace owns the transaction that deletes a
 * project; the workflows domain owns the SQL that erases the project's runs inside it (ADR 0008).
 * A stateless leaf, so the workspace can depend on it without importing the engine.
 */
export interface WorkflowRunErasureService {
  /**
   * Deletes every run of the project inside the caller's open transaction; children cascade.
   * Synchronous by design: it runs inside a better-sqlite3 transaction callback.
   * Returns the number of runs erased. Must not be called outside a transaction.
   */
  readonly eraseProjectRunsInTransaction: (db: RuntimeDrizzleDatabase, projectId: number) => number;
}

export const WorkflowRunErasure = Context.GenericTag<WorkflowRunErasureService>(
  'isagi/WorkflowRunErasure',
);

export const WorkflowRunErasureLive = Layer.succeed(WorkflowRunErasure, {
  eraseProjectRunsInTransaction: deleteRunsOfProject,
});
