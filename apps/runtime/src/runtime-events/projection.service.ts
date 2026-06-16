import { Effect, Layer } from 'effect';

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
    const subscription = yield* internalBus.subscribe({
      types: [
        'agent_session_changed',
        'terminal_session_changed',
        'pty_process_started',
        'pty_process_exited',
        'pty_process_failed',
        'pty_process_killed',
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
            if (agent) yield* publishAgentSessionChanged(publicBus, surfaces, agent);
            return;
          }
          if (event.type === 'terminal_session_changed') {
            const terminal = yield* terminals
              .find(event.terminalSessionId)
              .pipe(Effect.orElseSucceed(() => null));
            if (terminal) yield* publishTerminalSessionChanged(publicBus, surfaces, terminal);
            return;
          }
          const agent = yield* agents
            .findByActivePtyProcessId(event.ptyProcessId)
            .pipe(Effect.orElseSucceed(() => null));
          if (agent) yield* publishAgentSessionChanged(publicBus, surfaces, agent);
          const terminal = yield* terminals
            .findByActivePtyProcessId(event.ptyProcessId)
            .pipe(Effect.orElseSucceed(() => null));
          if (terminal) yield* publishTerminalSessionChanged(publicBus, surfaces, terminal);
        }),
      ),
    );
  }),
);

function publishAgentSessionChanged(
  publicBus: RuntimeEventBusService,
  surfaces: SurfaceRepositoryService,
  agent: AgentSessionRow,
) {
  return Effect.gen(function* () {
    const placement = yield* surfaces
      .findPaneForSession({ sessionKind: 'agent_session', sessionId: agent.id })
      .pipe(Effect.orElseSucceed(() => null));
    if (!placement) return;
    const state = deriveAgentSessionState(agent);
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
  });
}

function publishTerminalSessionChanged(
  publicBus: RuntimeEventBusService,
  surfaces: SurfaceRepositoryService,
  terminal: TerminalSessionRow,
) {
  return Effect.gen(function* () {
    const placement = yield* surfaces
      .findPaneForSession({ sessionKind: 'terminal_session', sessionId: terminal.id })
      .pipe(Effect.orElseSucceed(() => null));
    if (!placement) return;
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
  });
}
