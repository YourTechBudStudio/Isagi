/**
 * Connecting captured evidence back to the operation that produced it.
 *
 * The runtime cannot work this out from the content. Once `getConversationHistory` has returned a
 * string, which turn produced it is gone; so the author hands back the handle they already hold and
 * the runtime resolves that, rather than a new read verb being invented to ask.
 *
 * Nothing here ever fails a capture. A miss, a malformed handle, even a database error, all degrade
 * to `unresolved` — a record honestly saying the runtime could not connect this evidence to an
 * operation it made. The evidence is still saved, because it is still evidence. A confident wrong
 * attribution would be strictly worse than an honest gap: it is a false claim about provenance in
 * exactly the record someone consults six weeks later to settle an argument.
 */

import { Effect } from 'effect';

import type {
  WorkflowEvidenceSourceAttribution,
  WorkflowEvidenceSourceKind,
} from '@isagi/contracts';

import type { NormalizedEvidenceSource } from '../operations/correlation.js';
import type { WorkflowOperationsRepositoryService } from '../persistence/operations.repository.js';

export interface ResolvedSource {
  readonly kind: WorkflowEvidenceSourceKind;
  /** Recorded for all three session-bearing kinds, whether or not an operation resolved. */
  readonly agentSessionId: number | null;
  readonly operationId: number | null;
  readonly attribution: WorkflowEvidenceSourceAttribution;
}

const none: ResolvedSource = {
  kind: 'none',
  agentSessionId: null,
  operationId: null,
  attribution: 'none',
};

export function resolveEvidenceSource(
  operations: WorkflowOperationsRepositoryService,
  runId: number,
  source: NormalizedEvidenceSource | null,
): Effect.Effect<ResolvedSource, never> {
  if (source === null) return Effect.succeed(none);

  const resolved = Effect.gen(function* () {
    switch (source.kind) {
      case 'agent_turn': {
        // The receipt's `sentAt` *is* the persisted submission watermark, so this asks the exact
        // question "which submission was this turn" rather than "what did we last send".
        const record = yield* operations.findSubmission({
          runId,
          agentSessionId: source.agentSessionId,
          submissionWatermark: source.sentAt,
        });
        return {
          kind: 'agent_turn' as const,
          agentSessionId: source.agentSessionId,
          operationId: record?.id ?? null,
          attribution: (record ? 'exact' : 'unresolved') as WorkflowEvidenceSourceAttribution,
        };
      }
      case 'headless_operation': {
        const record = yield* operations.findByKey(source.operationId);
        // Both filters matter. The run scope stops a handle leaked through state from attributing
        // this run's evidence to another run's operation; the capability check stops an
        // operation key that happens to name something else from being read as a headless launch.
        const usable =
          record !== null && record.runId === runId && record.capability === 'run_headless_agent';
        return {
          kind: 'headless_operation' as const,
          agentSessionId: null,
          operationId: usable ? record.id : null,
          attribution: (usable ? 'exact' : 'unresolved') as WorkflowEvidenceSourceAttribution,
        };
      }
      case 'agent_session': {
        // No watermark: "the latest thing we sent this session". Inferred, and labelled as such —
        // the author named a session, not a turn, so the runtime must not claim it knows which.
        const record = yield* operations.findSubmission({
          runId,
          agentSessionId: source.agentSessionId,
        });
        return {
          kind: 'agent_session' as const,
          agentSessionId: source.agentSessionId,
          operationId: record?.id ?? null,
          attribution: (record
            ? 'inferred_latest_operation'
            : 'unresolved') as WorkflowEvidenceSourceAttribution,
        };
      }
    }
  });

  return resolved.pipe(
    Effect.catchAll((cause) => {
      // Warned rather than swallowed: the capture is still correct, but a database error during
      // attribution is a fact about the runtime that should not vanish into a null column.
      console.warn('[runtime] Workflow evidence source attribution failed; recording unresolved', {
        runId,
        sourceKind: source.kind,
        cause,
      });
      return Effect.succeed({
        kind: source.kind,
        agentSessionId: source.kind === 'headless_operation' ? null : source.agentSessionId,
        operationId: null,
        attribution: 'unresolved' as const,
      } satisfies ResolvedSource);
    }),
  );
}
