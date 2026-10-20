import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { makeLogCapture } from '../../../test/test-support.js';
import {
  FluidcastSessionUnreadable,
  FluidcastStartFailed,
  FluidcastUnavailable,
  type FluidcastSessionId,
} from '../../fluidcast/index.js';
import { HarnessAdapterError, HarnessLaunchBlocked } from '../../harnesses/index.js';
import { withApiServer } from '../../platform/http/testing.js';
import { DatabaseError } from '../../platform/persistence/index.js';
import { registerAgentSessionsApi } from './api.js';
import { AgentSessionAttentionProjection } from './attention.js';
import {
  AgentSessionError,
  AgentSessionService,
  AgentTerminalStopFailed,
  type SetInteractionModeError,
} from './service.js';

function projection(workingAgentCount: Effect.Effect<number, DatabaseError>) {
  return Layer.mergeAll(
    Layer.mock(AgentSessionAttentionProjection)({
      terminalSessionAttention: () => assert.fail('terminalSessionAttention is not used'),
      workingAgentCount,
    }),
    Layer.mock(AgentSessionService)({}),
  );
}

function switching(
  setInteractionMode: AgentSessionService['Service']['setInteractionMode'],
  calls: unknown[] = [],
) {
  return Layer.mergeAll(
    Layer.mock(AgentSessionAttentionProjection)({
      terminalSessionAttention: () => assert.fail('terminalSessionAttention is not used'),
    }),
    Layer.mock(AgentSessionService)({
      setInteractionMode: (input) => {
        calls.push(input);
        return setInteractionMode(input);
      },
    }),
  );
}

const from = { generation: 3, fluidcastSessionId: null, processIncarnation: 'pty:42' };

function putMode(
  fastify: Parameters<Parameters<typeof withApiServer>[2]>[0],
  mode: string,
  agentSessionId: number | string = 7,
  origin: unknown = from,
) {
  return fastify.inject({
    method: 'PUT',
    url: `/api/v1/agent-sessions/${agentSessionId}/interaction-mode`,
    payload: { mode, from: origin },
  });
}

test('set interaction mode passes the agent and mode through and returns the controller', () => {
  const calls: unknown[] = [];
  return withApiServer(
    switching(
      () => Effect.succeed({ mode: 'fluidcast', fluidcastSessionId: 'fc-1' as FluidcastSessionId }),
      calls,
    ),
    registerAgentSessionsApi,
    async (fastify) => {
      const response = await putMode(fastify, 'fluidcast');
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().data, { mode: 'fluidcast', fluidcastSessionId: 'fc-1' });
      assert.deepEqual(calls, [{ agentSessionId: 7, mode: 'fluidcast', from }]);

      const terminal = await putMode(fastify, 'terminal');
      assert.equal(terminal.statusCode, 200);
    },
  );
});

test('set interaction mode rejects an unknown mode before reaching the service', () => {
  const calls: unknown[] = [];
  return withApiServer(
    switching(() => assert.fail('the service is not reached'), calls),
    registerAgentSessionsApi,
    async (fastify) => {
      const response = await putMode(fastify, 'voice');
      assert.equal(response.statusCode, 400);
      assert.deepEqual(calls, []);
    },
  );
});

test('set interaction mode rejects a missing or malformed origin before reaching the service', () => {
  const calls: unknown[] = [];
  return withApiServer(
    switching(() => assert.fail('the service is not reached'), calls),
    registerAgentSessionsApi,
    async (fastify) => {
      const omitted = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/agent-sessions/7/interaction-mode',
        payload: { mode: 'fluidcast' },
      });
      assert.equal(omitted.statusCode, 400);
      for (const origin of [
        null,
        { generation: -1, fluidcastSessionId: null, processIncarnation: null },
        { generation: 1, fluidcastSessionId: null },
      ]) {
        const response = await putMode(fastify, 'fluidcast', 7, origin);
        assert.equal(response.statusCode, 400, JSON.stringify(origin));
      }
      assert.deepEqual(calls, []);
    },
  );
});

const mappings: ReadonlyArray<{
  readonly name: string;
  readonly failure: SetInteractionModeError;
  readonly status: number;
  readonly code: string;
  readonly data?: unknown;
  readonly message?: string;
}> = [
  {
    name: 'an unknown agent',
    failure: new AgentSessionError('session_not_found', 'Agent session 7 was not found.'),
    status: 404,
    code: 'agent_session_not_found',
  },
  {
    name: 'an agent no pane holds',
    failure: new AgentSessionError('session_not_placed', 'Agent session 7 is not placed.'),
    status: 404,
    code: 'agent_session_not_found',
  },
  {
    name: 'an agent being deleted',
    failure: new AgentSessionError('session_deleting', 'Agent session 7 is being deleted.'),
    status: 409,
    code: 'agent_session_deleting',
  },
  {
    name: 'missing harness metadata',
    failure: new AgentSessionError('harness_metadata_missing', 'missing'),
    status: 409,
    code: 'agent_session_metadata_unusable',
    data: { reason: 'harness_metadata_missing' },
  },
  {
    name: 'invalid harness metadata',
    failure: new AgentSessionError('harness_metadata_invalid', 'invalid'),
    status: 409,
    code: 'agent_session_metadata_unusable',
    data: { reason: 'harness_metadata_invalid' },
  },
  {
    name: 'a blocked launch',
    failure: new HarnessLaunchBlocked({
      harness: 'claude',
      reason: 'harness_disabled',
      diagnostic: null,
    }),
    status: 400,
    code: 'session_launch_rejected',
    data: { reason: 'harness_disabled' },
  },
  {
    name: 'Fluidcast disabled',
    failure: new FluidcastUnavailable({ reason: 'disabled' }),
    status: 409,
    code: 'fluidcast_unavailable',
    data: { reason: 'disabled' },
  },
  {
    name: 'invalid Fluidcast config',
    failure: new FluidcastUnavailable({ reason: 'invalid_config' }),
    status: 409,
    code: 'fluidcast_unavailable',
    data: { reason: 'invalid_config' },
  },
  {
    name: 'a harness with no SDK worker',
    failure: new FluidcastUnavailable({ reason: 'harness_unsupported' }),
    status: 409,
    code: 'fluidcast_unavailable',
    data: { reason: 'harness_unsupported' },
  },
  {
    name: 'an unreadable native session',
    failure: new FluidcastSessionUnreadable({ reason: 'SessionUnreadable' }),
    status: 422,
    code: 'fluidcast_session_unreadable',
    data: { reason: 'SessionUnreadable' },
  },
  {
    name: 'a missing native session',
    failure: new FluidcastSessionUnreadable({ reason: 'SessionNotFound' }),
    status: 422,
    code: 'fluidcast_session_unreadable',
    data: { reason: 'SessionNotFound' },
  },
  {
    name: 'a failed start',
    failure: new FluidcastStartFailed({ reason: 'session_build_failed' }),
    status: 500,
    code: 'fluidcast_start_failed',
    data: { reason: 'session_build_failed' },
  },
  {
    name: 'a database failure',
    failure: new DatabaseError({
      operation: 'find_agent_session',
      cause: new Error('secret database path /private/runtime.sqlite'),
    }),
    status: 500,
    code: 'runtime_database_failed',
  },
  {
    name: 'a harness adapter defect',
    failure: new HarnessAdapterError('unsupported_harness', 'Unsupported harness.'),
    status: 500,
    code: 'api_unhandled_error',
  },
  {
    name: 'an attach-only agent code',
    failure: new AgentSessionError('active_process_missing', 'no process'),
    status: 500,
    code: 'api_unhandled_error',
  },
  {
    // Switches never pass through the terminal-mode gate, so this is a defect.
    name: 'the terminal-mode gate',
    failure: new AgentSessionError('not_in_terminal_mode', 'not terminal'),
    status: 500,
    code: 'api_unhandled_error',
  },
  {
    name: 'a stale origin',
    failure: new AgentSessionError(
      'interaction_changed',
      'Agent session 7 changed controllers after this request was made.',
    ),
    status: 409,
    code: 'agent_interaction_changed',
    message: 'Agent session 7 changed controllers after this request was made.',
  },
  {
    name: 'a terminal stop that reported an error',
    failure: new AgentTerminalStopFailed({
      agentSessionId: 7,
      ptyProcessId: 42,
      diagnostic: 'PTY kill error (ptyProcess=42): Error',
    }),
    status: 500,
    code: 'agent_terminal_stop_failed',
    message:
      "The agent's terminal could not be stopped, so Fluidcast was not started: PTY kill error (ptyProcess=42): Error.",
  },
];

for (const mapping of mappings) {
  test(`set interaction mode answers ${mapping.name} with ${mapping.code}`, () =>
    withApiServer(
      Layer.mergeAll(
        switching(() => Effect.fail(mapping.failure)),
        makeLogCapture().layer,
      ),
      registerAgentSessionsApi,
      async (fastify) => {
        const response = await putMode(fastify, 'fluidcast');
        const error = response.json().error;
        assert.equal(response.statusCode, mapping.status);
        assert.equal(error.code, mapping.code);
        if (mapping.data !== undefined) assert.deepEqual(error.data, mapping.data);
        if (mapping.message !== undefined) assert.equal(error.message, mapping.message);
        assert.equal(JSON.stringify(error).includes('/private/runtime.sqlite'), false);
      },
    ));
}

test('agent session activity returns the schema-backed working count', () =>
  withApiServer(projection(Effect.succeed(2)), registerAgentSessionsApi, async (fastify) => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/v1/agent-sessions/activity',
    });
    const payload = response.json();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(payload.data, { workingAgentCount: 2 });
    assert.equal(typeof payload.meta.requestId, 'string');
  }));

test('agent session activity maps projection failures without leaking their cause', () => {
  const logs = makeLogCapture();
  return withApiServer(
    Layer.mergeAll(
      projection(
        Effect.fail(
          new DatabaseError({
            operation: 'working_agent_count',
            cause: new Error('secret database path /private/runtime.sqlite'),
          }),
        ),
      ),
      logs.layer,
    ),
    registerAgentSessionsApi,
    async (fastify) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/v1/agent-sessions/activity',
      });
      const payload = response.json();
      assert.equal(response.statusCode, 500);
      assert.equal(payload.error.code, 'agent_session_activity_unavailable');
      assert.equal(payload.error.message, 'Agent session activity could not be read.');
      assert.equal(JSON.stringify(payload).includes('/private/runtime.sqlite'), false);

      const failures = logs.lines.filter(
        (line) => line.message === 'Agent session activity read failed',
      );
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.level, 'Error');
      assert.equal(failures[0]?.annotations.endpointId, 'agent-sessions.activity');
      assert.match(String(failures[0]?.annotations.cause), /working_agent_count/);
      assert.equal(JSON.stringify(failures).includes('/private/runtime.sqlite'), false);
    },
  );
});
