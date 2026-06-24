import { Effect, Layer } from 'effect';

import type { AttentionSource } from '@isagi/contracts';

import { AgentSessionAttentionProjection } from '../agent-sessions/attention-projection.service.js';
import { AgentSessionRepository } from '../agent-sessions/index.js';
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
        'agent_session_changed',
        'terminal_session_changed',
        'surface_changed',
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
          if (event.type === 'agent_session_changed') {
            const agent = yield* agents
              .find(event.agentSessionId)
              .pipe(Effect.orElseSucceed(() => null));
            if (agent) {
              yield* publishAgentSessionChanged(publicBus, surfaces, attention, agent);
            } else {
              yield* publishAttentionSourceRemoved(publicBus, {
                kind: 'agent_session',
                id: event.agentSessionId,
              });
            }
            return;
          }
          if (event.type === 'terminal_session_changed') {
            const terminal = yield* terminals
              .find(event.terminalSessionId)
              .pipe(Effect.orElseSucceed(() => null));
            if (terminal) {
              yield* publishTerminalSessionChanged(publicBus, surfaces, attention, terminal);
            } else {
              yield* publishAttentionSourceRemoved(publicBus, {
                kind: 'terminal_session',
                id: event.terminalSessionId,
              });
            }
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
          const agent = yield* agents
            .findByActivePtyProcessId(event.ptyProcessId)
            .pipe(Effect.orElseSucceed(() => null));
          if (agent) yield* publishAgentSessionChanged(publicBus, surfaces, attention, agent);
          const terminal = yield* terminals
            .findByActivePtyProcessId(event.ptyProcessId)
            .pipe(Effect.orElseSucceed(() => null));
          if (terminal)
            yield* publishTerminalSessionChanged(publicBus, surfaces, attention, terminal);
        }),
      ),
    );
  }),
);

function publishAgentSessionChanged(
  publicBus: RuntimeEventBusService,
  surfaces: SurfaceRepositoryService,
  attention: import('../agent-sessions/index.js').AgentSessionAttentionProjectionService,
  agent: AgentSessionRow,
) {
  return Effect.gen(function* () {
    const placement = yield* surfaces
      .findPaneForSession({ sessionKind: 'agent_session', sessionId: agent.id })
      .pipe(Effect.orElseSucceed(() => null));
    if (!placement) {
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
        worktreeId: placement.worktreeId,
        surfaceId: placement.surfaceId,
        paneId: placement.paneId,
        status: state.status,
        statusReason: state.statusReason,
        diagnosticCode: state.diagnosticCode,
      },
    });
    yield* publishAttentionSourceChanged(publicBus, {
      ...placement,
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
    const placement = yield* surfaces
      .findPaneForSession({ sessionKind: 'terminal_session', sessionId: terminal.id })
      .pipe(Effect.orElseSucceed(() => null));
    if (!placement) {
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
        worktreeId: placement.worktreeId,
        surfaceId: placement.surfaceId,
        paneId: placement.paneId,
        status: state.status,
        statusReason: state.statusReason,
        diagnosticCode: state.diagnosticCode,
      },
    });
    yield* publishAttentionSourceChanged(publicBus, {
      ...placement,
      source: { kind: 'terminal_session', id: terminal.id },
      attention: attention.terminalSessionAttention(terminal),
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
