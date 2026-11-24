import type {
  EditorContextFacts as ContractEditorContextFacts,
  EditorAttemptFailureReason,
} from '@isagi/shared/contracts';

// Read-side composition only: the editor context carries the process the
// runtime joined onto its pointer. The PTY domain owns the row itself
// (ADR 0005/0008).
import type { PtyProcessRow } from '../../pty-processes/index.js';

/**
 * The launch-attempt record, decoded from four nullable columns into the union
 * the domain actually reasons about. Callers never see a loose
 * `attemptState`/`attemptReason`/`attemptDetail`/`attemptStartedAt` quartet,
 * so no consumer can read a reason that belongs to a state that does not have
 * one. This mirrors the contract's `editorAttemptSchema` exactly.
 */
export type EditorAttemptRecord =
  | { readonly state: 'none' }
  | { readonly state: 'in_progress'; readonly startedAt: string }
  | {
      readonly state: 'failed';
      readonly reason: EditorAttemptFailureReason;
      readonly detail: string | null;
    };

/**
 * The durable editor context: one per worktree, sitting above zero or one
 * replaceable process incarnation (ADR 0006). The pointer and the session
 * socket are installed and cleared together, so they are both null or both set.
 */
export interface EditorContextRow {
  readonly id: number;
  readonly worktreeId: number;
  readonly activePtyProcessId: number | null;
  readonly sessionSocketPath: string | null;
  readonly attempt: EditorAttemptRecord;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Joined at read time, exactly as `AgentSessionRow.activePtyProcess` is. A
   * non-null `activePtyProcessId` with a null process here is valid, not
   * malformed: the pointer is durable and the row it names can be collected.
   */
  readonly activePtyProcess: PtyProcessRow | null;
}

/**
 * What a launch chooses for an incarnation and hands to the repository in one
 * transition. Grouped so no call site can install a pointer without the session
 * socket that belongs to it.
 */
export interface EditorIncarnationHandoff {
  readonly ptyProcessId: number;
  readonly sessionSocketPath: string;
}

/**
 * What this runtime *observed* about a live workbench.
 *
 * Deliberately in memory only, and keyed by PTY process id rather than by
 * context id: a durable context outlives its incarnations, so an observation
 * stored against the context could be read back against a different process
 * than the one it describes. Persisting it would be worse still — a readiness
 * fact from a previous runtime describes a process that no longer exists.
 */
export interface EditorReadinessObservation {
  readonly ptyProcessId: number;
  readonly state: 'pending' | 'ready' | 'unreachable';
  readonly detail: string | null;
  readonly observedAt: string;
}

/**
 * The contract's `editorContextFactsSchema` type under the runtime's own name,
 * so the service signature reads in domain terms. The runtime never defines a
 * parallel shape for it: the contract is the single declaration.
 */
export type EditorContextFacts = ContractEditorContextFacts;
