import type {
  WorkflowErrorDto,
  WorkflowOutcomeDto,
  WorkflowPlacementRequestDto,
  WorkflowPlacementSource,
} from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../persistence/index.js';
import type {
  workflowArtifacts,
  workflowEvents,
  workflowExecutions,
  workflowGraphInvocations,
  workflowOperations,
  workflowRuns,
} from '../../persistence/schema.js';

/**
 * Row shapes and the JSON column helpers every store file shares.
 *
 * The store is plain CRUD: synchronous functions over one database handle, so the engine can compose
 * several of them inside one transaction. `*_json` columns hold plain JSON; `null` in the column is
 * an absent value, never the JSON literal `null`.
 */
export type Db = RuntimeDrizzleDatabase;

export type ArtifactRow = typeof workflowArtifacts.$inferSelect;
export type RunRow = typeof workflowRuns.$inferSelect;
export type InvocationRow = typeof workflowGraphInvocations.$inferSelect;
export type ExecutionRow = typeof workflowExecutions.$inferSelect;
export type OperationRow = typeof workflowOperations.$inferSelect;
export type EventRow = typeof workflowEvents.$inferSelect;

/** `placement_json`: what was asked for, who decided it, and the commit a `create` resolved to. */
export interface RunPlacement {
  readonly source: WorkflowPlacementSource;
  readonly request: WorkflowPlacementRequestDto;
  readonly baseCommit: string | null;
}

export type RunError = WorkflowErrorDto;
export type Outcome = WorkflowOutcomeDto;

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function fromJson<T>(text: string): T;
export function fromJson<T>(text: string | null): T | null;
export function fromJson<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

/** Both a nullable value and an absent one, stored as SQL `NULL`. */
export function toNullableJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function now(): string {
  return new Date().toISOString();
}
