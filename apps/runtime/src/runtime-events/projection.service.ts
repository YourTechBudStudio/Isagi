import { Effect, Layer } from 'effect';

import { AgentSessionRepository } from '../agent-sessions/index.js';
import { deriveAgentSessionState, deriveTerminalSessionState } from '../surfaces/session-status.js';
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
            if (agent) yield* publishAgentSessionChanged(publicBus, agent);
            return;
          }
          if (event.type === 'terminal_session_changed') {
            const terminal = yield* terminals
              .find(event.terminalSessionId)
              .pipe(Effect.orElseSucceed(() => null));
            if (terminal) yield* publishTerminalSessionChanged(publicBus, terminal);
            return;
          }
          const agent = yield* agents
            .findByActivePtyProcessId(event.ptyProcessId)
            .pipe(Effect.orElseSucceed(() => null));
          if (agent) yield* publishAgentSessionChanged(publicBus, agent);
          const terminal = yield* terminals
            .findByActivePtyProcessId(event.ptyProcessId)
            .pipe(Effect.orElseSucceed(() => null));
          if (terminal) yield* publishTerminalSessionChanged(publicBus, terminal);
        }),
      ),
    );
  }),
);

function publishAgentSessionChanged(publicBus: RuntimeEventBusService, agent: AgentSessionRow) {
  const state = deriveAgentSessionState(agent);
  return publicBus.publish({
    ...nextRuntimeEventEnvelope(),
    type: 'agent_session_changed',
    payload: {
      agentSessionId: agent.id,
      worktreeId: agent.worktreeId,
      surfaceId: agent.surfaceId,
      paneId: agent.paneId,
      status: state.status,
      statusReason: state.statusReason,
      diagnosticCode: state.diagnosticCode,
    },
  });
}

function publishTerminalSessionChanged(
  publicBus: RuntimeEventBusService,
  terminal: TerminalSessionRow,
) {
  const state = deriveTerminalSessionState(terminal);
  return publicBus.publish({
    ...nextRuntimeEventEnvelope(),
    type: 'terminal_session_changed',
    payload: {
      terminalSessionId: terminal.id,
      worktreeId: terminal.worktreeId,
      surfaceId: terminal.surfaceId,
      paneId: terminal.paneId,
      status: state.status,
      statusReason: state.statusReason,
      diagnosticCode: state.diagnosticCode,
    },
  });
}
