import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import { registerApiEndpoint, type RouteRuntime } from '../../platform/http/index.js';
import { sessionLaunchRejection } from '../surfaces/api.js';
import { AgentSessionAttentionProjection } from './attention.js';
import { AgentSessionService } from './service.js';

export function registerAgentSessionsApi(
  fastify: FastifyInstance,
  runtime: RouteRuntime<AgentSessionAttentionProjection | AgentSessionService>,
) {
  registerApiEndpoint(fastify, runtime, apiEndpoints.agentSessions.activity, (request) =>
    AgentSessionAttentionProjection.use((projection) => projection.workingAgentCount).pipe(
      Effect.map((workingAgentCount) => ({ workingAgentCount })),
      // The client gets a fixed message; the runtime log names the failed operation.
      Effect.catchTag('DatabaseError', (error) =>
        Effect.logError('Agent session activity read failed').pipe(
          Effect.annotateLogs({ cause: describeOperationalCause(error) }),
          Effect.andThen(
            request.reject({
              code: 'agent_session_activity_unavailable',
              status: 500,
              message: 'Agent session activity could not be read.',
            }),
          ),
        ),
      ),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.agentSessions.setInteractionMode, (request) =>
    AgentSessionService.use((agents) =>
      agents.setInteractionMode({
        agentSessionId: request.params.agentSessionId,
        mode: request.body.mode,
        from: request.body.from,
      }),
    ).pipe(
      Effect.catchTags({
        AgentSessionError: (error) => {
          switch (error.code) {
            // A session no pane holds is gone as far as the user is concerned.
            case 'session_not_found':
            case 'session_not_placed':
              return request.reject({
                code: 'agent_session_not_found',
                status: 404,
                message: error.message,
              });
            case 'session_deleting':
              return request.reject({
                code: 'agent_session_deleting',
                status: 409,
                message: error.message,
              });
            case 'interaction_changed':
              return request.reject({
                code: 'agent_interaction_changed',
                status: 409,
                message: error.message,
              });
            case 'harness_metadata_missing':
            case 'harness_metadata_invalid':
              return request.reject({
                code: 'agent_session_metadata_unusable',
                status: 409,
                message: error.message,
                data: { reason: error.code },
              });
            // Attach and send codes: a mode change never raises them. Switches launch directly,
            // never through the terminal-mode gate.
            case 'active_process_missing':
            case 'active_process_not_running':
            case 'process_incarnation_stale':
            case 'not_in_terminal_mode':
              return Effect.die(error);
          }
        },
        HarnessLaunchBlocked: (blocked) => request.reject(sessionLaunchRejection(blocked)),
        HarnessAdapterError: (error) => Effect.die(error),
        AgentTerminalStopFailed: (error) =>
          request.reject({
            code: 'agent_terminal_stop_failed',
            status: 500,
            message: `The agent's terminal could not be stopped, so Fluidcast was not started: ${error.diagnostic}.`,
          }),
        FluidcastUnavailable: (error) =>
          request.reject({
            code: 'fluidcast_unavailable',
            status: 409,
            message: `Fluidcast is unavailable: ${error.reason}.`,
            data: { reason: error.reason },
          }),
        FluidcastSessionUnreadable: (error) =>
          request.reject({
            code: 'fluidcast_session_unreadable',
            status: 422,
            message: `The agent's native session could not be attached: ${error.reason}.`,
            data: { reason: error.reason },
          }),
        FluidcastStartFailed: (error) =>
          request.reject({
            code: 'fluidcast_start_failed',
            status: 500,
            message: `The Fluidcast session could not be started: ${error.reason}.`,
            data: { reason: error.reason },
          }),
      }),
    ),
  );
}
