import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Either, Layer } from 'effect';

import {
  AgentSessionError,
  AgentSessionService,
  type AgentSessionServiceShape,
} from '../agent-sessions/index.js';
import {
  HarnessEventError,
  HarnessEventService,
  HarnessEventServiceLive,
} from './harness-events.service.js';
import {
  HarnessEventTokenRegistry,
  type HarnessEventTokenRecord,
  type HarnessEventTokenRegistryService,
} from './token-registry.js';

for (const harness of ['pi', 'opencode', 'claude', 'codex'] as const) {
  test(`harness event service records a ${harness} observation against the token-owned agent process`, async () => {
    const observations: Parameters<
      AgentSessionServiceShape['recordHarnessSessionObservation']
    >[0][] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* HarnessEventService;
        yield* service.handle({
          token: 'valid-token',
          event: {
            type: 'harness_session_observed',
            harness,
            harnessSessionId: `${harness}-session-1`,
            source: `${harness}_source`,
            agentSessionId: 10,
          },
        });
      }).pipe(
        Effect.provide(
          testLayer({
            token: tokenRecord({ harness }),
            observations,
          }),
        ),
      ),
    );

    assert.deepEqual(observations, [
      {
        agentSessionId: 10,
        ptyProcessId: 20,
        harness,
        harnessSessionId: `${harness}-session-1`,
        source: `${harness}_source`,
      },
    ]);
  });
}

test('harness event service rejects a wrong harness for a valid token', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* HarnessEventService;
      return yield* service
        .handle({
          token: 'valid-token',
          event: {
            type: 'harness_session_observed',
            harness: 'claude',
            harnessSessionId: 'claude-session-1',
            source: 'SessionStart',
            agentSessionId: 10,
          },
        })
        .pipe(Effect.either);
    }).pipe(Effect.provide(testLayer({ token: tokenRecord(), observations: [] }))),
  );

  assert.equal(Either.isLeft(result), true);
  assert.equal(
    Either.isLeft(result) && result.left instanceof HarnessEventError
      ? result.left.code
      : undefined,
    'harness_mismatch',
  );
});

test('harness event service rejects an event for a different agent session id', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* HarnessEventService;
      return yield* service
        .handle({
          token: 'valid-token',
          event: {
            type: 'harness_session_observed',
            harness: 'pi',
            harnessSessionId: 'pi-session-1',
            source: 'turn_start',
            agentSessionId: 11,
          },
        })
        .pipe(Effect.either);
    }).pipe(Effect.provide(testLayer({ token: tokenRecord(), observations: [] }))),
  );

  assert.equal(Either.isLeft(result), true);
  assert.equal(
    Either.isLeft(result) && result.left instanceof HarnessEventError
      ? result.left.code
      : undefined,
    'agent_session_mismatch',
  );
});

test('harness event service preserves agent service active-process validation', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* HarnessEventService;
      return yield* service
        .handle({
          token: 'valid-token',
          event: {
            type: 'harness_session_observed',
            harness: 'pi',
            harnessSessionId: 'pi-session-1',
            source: 'agent_start',
            agentSessionId: 10,
          },
        })
        .pipe(Effect.either);
    }).pipe(
      Effect.provide(
        testLayer({
          token: tokenRecord(),
          observations: [],
          recordError: new AgentSessionError(
            'active_process_mismatch',
            'Harness event does not match the active process.',
          ),
        }),
      ),
    ),
  );

  assert.equal(Either.isLeft(result), true);
  assert.equal(
    Either.isLeft(result) && result.left instanceof AgentSessionError
      ? result.left.code
      : undefined,
    'active_process_mismatch',
  );
});

function testLayer(input: {
  readonly token: HarnessEventTokenRecord | null;
  readonly observations: Parameters<
    AgentSessionServiceShape['recordHarnessSessionObservation']
  >[0][];
  readonly recordError?: AgentSessionError | undefined;
}) {
  return HarnessEventServiceLive.pipe(
    Layer.provide(Layer.succeed(HarnessEventTokenRegistry, fakeTokenRegistry(input.token))),
    Layer.provide(Layer.succeed(AgentSessionService, fakeAgentSessionService(input))),
  );
}

function tokenRecord(
  input: Partial<Pick<HarnessEventTokenRecord, 'harness'>> = {},
): HarnessEventTokenRecord {
  return {
    token: 'valid-token',
    agentSessionId: 10,
    ptyProcessId: 20,
    harness: input.harness ?? 'pi',
    createdAt: '2026-06-16T00:00:00.000Z',
  };
}

function fakeTokenRegistry(
  token: HarnessEventTokenRecord | null,
): HarnessEventTokenRegistryService {
  return {
    create: () => Effect.die('create is not used'),
    resolve: () => Effect.succeed(token),
    revoke: () => Effect.void,
    revokeByPtyProcessId: () => Effect.void,
  } satisfies HarnessEventTokenRegistryService;
}

function fakeAgentSessionService(input: {
  readonly observations: Parameters<
    AgentSessionServiceShape['recordHarnessSessionObservation']
  >[0][];
  readonly recordError?: AgentSessionError | undefined;
}): AgentSessionServiceShape {
  return {
    startFresh: () => Effect.die('startFresh is not used'),
    get: () => Effect.die('get is not used'),
    ensureActivePtyProcess: () => Effect.die('ensureActivePtyProcess is not used'),
    activePtyProcessId: () => Effect.die('activePtyProcessId is not used'),
    recordHarnessSessionObservation: (observation) =>
      input.recordError
        ? Effect.fail(input.recordError)
        : Effect.sync(() => {
            input.observations.push(observation);
          }),
  } satisfies AgentSessionServiceShape;
}
