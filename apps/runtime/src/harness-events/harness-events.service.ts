import { Context, Data, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { AgentSessionError, AgentSessionService } from '../agent-sessions/index.js';
import { DatabaseError } from '../persistence/index.js';
import { HarnessEventTokenRegistry } from './token-registry.js';

export interface HarnessSessionObservedEvent {
  readonly type: 'harness_session_observed';
  readonly harness: AgentHarness;
  readonly harnessSessionId: string;
  readonly source: string | null;
  readonly agentSessionId: number | null;
}

export class HarnessEventError extends Data.TaggedError('HarnessEventError')<{
  readonly code:
    | 'auth_failed'
    | 'token_not_found'
    | 'harness_mismatch'
    | 'agent_session_mismatch'
    | 'event_process_mismatch'
    | 'unsupported_event';
  readonly message: string;
}> {}

export interface HarnessEventService {
  readonly handle: (input: {
    readonly token: string;
    readonly event: HarnessSessionObservedEvent;
  }) => Effect.Effect<void, HarnessEventError | DatabaseError | AgentSessionError>;
}

export const HarnessEventService = Context.GenericTag<HarnessEventService>(
  'isagi/HarnessEventService',
);

export const HarnessEventServiceLive = Layer.effect(
  HarnessEventService,
  Effect.gen(function* () {
    const tokens = yield* HarnessEventTokenRegistry;
    const agents = yield* AgentSessionService;

    return {
      handle: (input) =>
        Effect.gen(function* () {
          const token = yield* tokens.resolve(input.token);
          if (!token) {
            console.warn('[runtime] Harness event token lookup failed', {
              harness: input.event.harness,
              harnessSessionId: input.event.harnessSessionId,
              source: input.event.source,
              eventAgentSessionId: input.event.agentSessionId,
            });
            return yield* Effect.fail(
              new HarnessEventError({
                code: 'token_not_found',
                message: 'Harness event token was not recognized.',
              }),
            );
          }
          console.info('[runtime] Harness event token resolved', {
            tokenAgentSessionId: token.agentSessionId,
            tokenPtyProcessId: token.ptyProcessId,
            tokenHarness: token.harness,
            eventHarness: input.event.harness,
            eventAgentSessionId: input.event.agentSessionId,
            harnessSessionId: input.event.harnessSessionId,
            source: input.event.source,
          });
          if (token.harness !== input.event.harness) {
            return yield* Effect.fail(
              new HarnessEventError({
                code: 'harness_mismatch',
                message: `Harness event token was issued for ${token.harness}, not ${input.event.harness}.`,
              }),
            );
          }
          if (
            input.event.agentSessionId !== null &&
            input.event.agentSessionId !== token.agentSessionId
          ) {
            return yield* Effect.fail(
              new HarnessEventError({
                code: 'agent_session_mismatch',
                message: 'Harness event agent session did not match the token target.',
              }),
            );
          }
          yield* agents.recordHarnessSessionObservation({
            agentSessionId: token.agentSessionId,
            ptyProcessId: token.ptyProcessId,
            harness: token.harness,
            harnessSessionId: input.event.harnessSessionId,
            source: input.event.source,
          });
        }),
    } satisfies HarnessEventService;
  }),
);
