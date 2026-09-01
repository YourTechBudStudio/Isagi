import { Effect, Layer } from 'effect';

import type { AttentionSource } from '@isagi/contracts';

import { AgentSessionAttentionProjection } from '../agent-sessions/attention-projection.service.js';
import { AgentSessionRepository } from '../agent-sessions/index.js';
import { describeOperationalCause } from '../diagnostics/operational-cause.js';
import { deriveAgentSessionState, deriveTerminalSessionState } from '../surfaces/session-status.js';
import {
  SurfaceRepository,
  type SurfaceRepositoryService,
} from '../surfaces/surfaces.repository.js';
import type { AgentSessionRow, TerminalSessionRow } from '../surfaces/types.js';
import { TerminalSessionRepository } from '../terminal-sessions/index.js';
import {
  nextRuntimeEventEnvelope,
  RuntimeEventBus,
  type RuntimeEventBusService,
} from './event-bus.js';
import { InternalRuntimeEventBus } from './internal-event-bus.js';

export const RuntimeEventProjectionLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const internalBus = yield* InternalRuntimeEventBus;
    const publicBus = yield* RuntimeEventBus;
    const agents = yield* AgentSessionRepository;
    const terminals = yield* TerminalSessionRepository;
    const surfaces = yield* SurfaceRepository;
    const attention = yield* AgentSessionAttentionProjection;
    const subscription = yield* internalBus.subscribe({
      types: [
        'durable_session_deleted',
        'agent_session_changed',
        'terminal_session_changed',
        'surface_changed',
        'editor_context_changed',
        'pty_process_started',
        'pty_process_exited',
        'pty_process_failed',
        'pty_process_killed',
        'pty_foreground_command_started',
        'pty_foreground_command_ended',
      ],
    });

    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if (event.type === 'durable_session_deleted') {
            yield* publicBus.publish({
              ...nextRuntimeEventEnvelope(),
              type: 'durable_session_deleted',
              payload: event.identity,
            });
            return;
          }
          if (event.type === 'agent_session_changed') {
            const agent = yield* resolveLookup(agents.find(event.agentSessionId), {
              lookup: 'agent_session_row',
              entityId: event.agentSessionId,
            });
            if (agent.outcome === 'failed') return;
            if (agent.outcome === 'absent') {
              yield* publishAttentionSourceRemoved(publicBus, {
                kind: 'agent_session',
                id: event.agentSessionId,
              });
              return;
            }
            yield* publishAgentSessionChanged(publicBus, surfaces, attention, agent.value);
            return;
          }
          if (event.type === 'terminal_session_changed') {
            const terminal = yield* resolveLookup(terminals.find(event.terminalSessionId), {
              lookup: 'terminal_session_row',
              entityId: event.terminalSessionId,
            });
            if (terminal.outcome === 'failed') return;
            if (terminal.outcome === 'absent') {
              yield* publishAttentionSourceRemoved(publicBus, {
                kind: 'terminal_session',
                id: event.terminalSessionId,
              });
              return;
            }
            yield* publishTerminalSessionChanged(publicBus, surfaces, attention, terminal.value);
            return;
          }
          if (event.type === 'editor_context_changed') {
            yield* publishEditorContextChanged(publicBus, surfaces, event.editorContextId);
            return;
          }
          if (event.type === 'surface_changed') {
            yield* publicBus.publish({
              ...nextRuntimeEventEnvelope(),
              type: 'surface_changed',
              payload: event.payload,
            });
            return;
          }
          if (
            event.type !== 'pty_process_started' &&
            event.type !== 'pty_process_exited' &&
            event.type !== 'pty_process_failed' &&
            event.type !== 'pty_process_killed' &&
            event.type !== 'pty_foreground_command_started' &&
            event.type !== 'pty_foreground_command_ended'
          ) {
            return;
          }
          // No `attention_source_removed` here in any outcome: a PTY process with
          // no owning session names no attention source to remove.
          const terminal = yield* resolveLookup(
            terminals.findByActivePtyProcessId(event.ptyProcessId),
            { lookup: 'terminal_session_by_active_pty_process', entityId: event.ptyProcessId },
          );
          if (terminal.outcome === 'found')
            yield* publishTerminalSessionChanged(publicBus, surfaces, attention, terminal.value);
        }),
      ),
    );
  }),
);

/**
 * A projection lookup has three outcomes, and the projection must keep them
 * apart.
 *
 * A failure cannot be allowed to kill this subscriber: it is one long-lived loop
 * serving every event, so a single bad read must degrade rather than tear it
 * down. But degrading it to `null` and letting callers read that as "the row is
 * gone" is how a transient database error becomes a *lie* — the agent and
 * terminal branches answer a missing row by publishing `attention_source_removed`,
 * and the client deletes that source from its attention store. A session that is
 * genuinely waiting on the user would silently stop asking for them.
 *
 * So `found` and `absent` stay distinct from `failed`, and only `absent` is
 * evidence of anything. On `failed` the projection emits nothing at all and
 * leaves the client holding its last known-good state, which is stale but true;
 * the next event for that entity re-derives it. The failure is not lost, it is
 * demoted to a log line naming the lookup, the entity, and the operational cause
 * rendered through the sanitizing `describeOperationalCause`.
 *
 * The label names the *lookup* rather than the triggering event type on purpose:
 * `publishTerminalSessionChanged` runs for both `terminal_session_changed` and
 * the six PTY events, so an event type recorded here would be a guess, while the
 * lookup name always identifies the exact step.
 *
 * There is deliberately no retry. A retry would stall the single subscriber loop
 * behind one bad read and reorder every event queued behind it, which is a worse
 * failure than dropping one projection of state the next event re-derives.
 */
type LookupOutcome<A> =
  | { readonly outcome: 'found'; readonly value: A }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'failed' };

function resolveLookup<A>(
  lookup: Effect.Effect<A | null, unknown>,
  context: { readonly lookup: string; readonly entityId: number },
): Effect.Effect<LookupOutcome<A>> {
  return lookup.pipe(
    Effect.map(
      (value): LookupOutcome<A> =>
        value === null ? { outcome: 'absent' } : { outcome: 'found', value },
    ),
    Effect.catchAll((error) =>
      Effect.logWarning(
        `[runtime] runtime event projection lookup failed lookup=${context.lookup} ` +
          `entityId=${context.entityId} cause=${describeOperationalCause(error)}`,
      ).pipe(Effect.as<LookupOutcome<A>>({ outcome: 'failed' })),
    ),
  );
}

function publishAgentSessionChanged(
  publicBus: RuntimeEventBusService,
  surfaces: SurfaceRepositoryService,
  attention: import('../agent-sessions/index.js').AgentSessionAttentionProjectionService,
  agent: AgentSessionRow,
) {
  return Effect.gen(function* () {
    const placement = yield* resolveLookup(
      surfaces.findPaneForSession({ sessionKind: 'agent_session', sessionId: agent.id }),
      { lookup: 'agent_session_placement', entityId: agent.id },
    );
    if (placement.outcome === 'failed') return;
    if (placement.outcome === 'absent') {
      yield* publishAttentionSourceRemoved(publicBus, { kind: 'agent_session', id: agent.id });
      return;
    }
    const state = deriveAgentSessionState(agent);
    const attentionState = yield* attention.agentSessionAttention(agent);
    yield* publicBus.publish({
      ...nextRuntimeEventEnvelope(),
      type: 'agent_session_changed',
      payload: {
        agentSessionId: agent.id,
        worktreeId: placement.value.worktreeId,
        surfaceId: placement.value.surfaceId,
        paneId: placement.value.paneId,
        status: state.status,
        statusReason: state.statusReason,
        diagnosticCode: state.diagnosticCode,
      },
    });
    yield* publishAttentionSourceChanged(publicBus, {
      ...placement.value,
      source: { kind: 'agent_session', id: agent.id },
      attention: attentionState,
    });
  });
}

function publishTerminalSessionChanged(
  publicBus: RuntimeEventBusService,
  surfaces: SurfaceRepositoryService,
  attention: import('../agent-sessions/index.js').AgentSessionAttentionProjectionService,
  terminal: TerminalSessionRow,
) {
  return Effect.gen(function* () {
    const placement = yield* resolveLookup(
      surfaces.findPaneForSession({ sessionKind: 'terminal_session', sessionId: terminal.id }),
      { lookup: 'terminal_session_placement', entityId: terminal.id },
    );
    if (placement.outcome === 'failed') return;
    if (placement.outcome === 'absent') {
      yield* publishAttentionSourceRemoved(publicBus, {
        kind: 'terminal_session',
        id: terminal.id,
      });
      return;
    }
    const state = deriveTerminalSessionState(terminal);
    yield* publicBus.publish({
      ...nextRuntimeEventEnvelope(),
      type: 'terminal_session_changed',
      payload: {
        terminalSessionId: terminal.id,
        worktreeId: placement.value.worktreeId,
        surfaceId: placement.value.surfaceId,
        paneId: placement.value.paneId,
        status: state.status,
        statusReason: state.statusReason,
        diagnosticCode: state.diagnosticCode,
      },
    });
    yield* publishAttentionSourceChanged(publicBus, {
      ...placement.value,
      source: { kind: 'terminal_session', id: terminal.id },
      attention: attention.terminalSessionAttention(terminal),
    });
  });
}

/**
 * The internal-to-public bridge for editors, deliberately shaped like the two
 * session publishers above minus their status derivation.
 *
 * It does not read editor facts, and it cannot: `EditorContextService` holds
 * readiness in memory and this layer is given only `SurfaceRepository`. Identity
 * plus placement is exactly what this layer can produce, which is what shaped
 * the payload.
 *
 * It also publishes no attention source. Editors have no turn lifecycle, so an
 * unplaced context emits nothing at all rather than an `attention_source_removed`
 * naming a vocabulary editors are not in. That case is reachable and normal:
 * surface deletion removes placement and then publishes `surface_changed`, which
 * is what the client acts on.
 */
function publishEditorContextChanged(
  publicBus: RuntimeEventBusService,
  surfaces: SurfaceRepositoryService,
  editorContextId: number,
) {
  return Effect.gen(function* () {
    const placement = yield* resolveLookup(
      surfaces.findPaneForSession({ sessionKind: 'editor_context', sessionId: editorContextId }),
      { lookup: 'editor_context_placement', entityId: editorContextId },
    );
    // Editors publish no attention source, so absence and failure agree here on
    // what to emit — nothing. They still differ in what they mean, which is why
    // only the failed one left a breadcrumb.
    if (placement.outcome !== 'found') return;
    yield* publicBus.publish({
      ...nextRuntimeEventEnvelope(),
      type: 'editor_context_changed',
      payload: { editorContextId, ...placement.value },
    });
  });
}

function publishAttentionSourceChanged(publicBus: RuntimeEventBusService, source: AttentionSource) {
  return publicBus.publish({
    ...nextRuntimeEventEnvelope(),
    type: 'attention_source_changed',
    payload: source,
  });
}

function publishAttentionSourceRemoved(
  publicBus: RuntimeEventBusService,
  source: AttentionSource['source'],
) {
  return publicBus.publish({
    ...nextRuntimeEventEnvelope(),
    type: 'attention_source_removed',
    payload: { source },
  });
}
