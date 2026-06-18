import assert from 'node:assert/strict';
import test from 'node:test';

import websocket from '@fastify/websocket';
import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import type { RuntimeEvent } from '@isagi/contracts';

import { AgentSessionAttentionProjection } from '../agent-sessions/index.js';
import { registerRuntimeEventsApi } from './api.js';
import {
  RuntimeEventBus,
  RuntimeEventBusLive,
  type RuntimeEventSubscription,
} from './event-bus.js';

test('runtime events websocket streams published events through the contract path', async () => {
  const event = agentSessionChangedEvent();
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(RuntimeEventBusLive);

  try {
    await fastify.register(websocket);
    registerRuntimeEventsApi(fastify, runtime as never);
    await fastify.ready();

    const ws = await fastify.injectWS('/api/v1/events');
    try {
      await new Promise((resolve) => setImmediate(resolve));
      await runtime.runPromise(
        Effect.gen(function* () {
          const eventBus = yield* RuntimeEventBus;
          yield* eventBus.publish(event);
        }),
      );
      assert.deepEqual(await takeMessage(ws), event);
    } finally {
      ws.terminate();
    }
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('runtime events websocket answers explicit attention snapshot requests', async () => {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      RuntimeEventBusLive,
      Layer.succeed(AgentSessionAttentionProjection, {
        reconcileAgentSession: () => Effect.void,
        agentSessionAttention: () => Effect.succeed('idle' as const),
        terminalSessionAttention: () => 'idle' as const,
        listAttentionSources: Effect.succeed([
          {
            worktreeId: 2,
            surfaceId: 3,
            paneId: 4,
            source: { kind: 'agent_session' as const, id: 1 },
            attention: 'working' as const,
          },
        ]),
      }),
    ),
  );

  try {
    await fastify.register(websocket);
    registerRuntimeEventsApi(fastify, runtime as never);
    await fastify.ready();

    const ws = await fastify.injectWS('/api/v1/events');
    try {
      ws.send(JSON.stringify({ type: 'attention_snapshot_requested' }));
      const event = await takeMessage(ws);
      assert.match(event.id, /^evt_/);
      assert.match(event.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(event, {
        id: event.id,
        type: 'attention_snapshot',
        occurredAt: event.occurredAt,
        payload: {
          sources: [
            {
              worktreeId: 2,
              surfaceId: 3,
              paneId: 4,
              source: { kind: 'agent_session', id: 1 },
              attention: 'working',
            },
          ],
        },
      });
    } finally {
      ws.terminate();
    }
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('runtime events websocket rejects disallowed origins before upgrade', async () => {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(Layer.succeed(RuntimeEventBus, fakeEventBus()));

  try {
    await fastify.register(websocket);
    registerRuntimeEventsApi(fastify, runtime as never);
    await fastify.ready();

    await assert.rejects(
      fastify.injectWS('/api/v1/events', {
        headers: { origin: 'https://not-isagi.example' },
      }),
    );
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('runtime events websocket unsubscribes if the socket closes before subscribe resolves', async () => {
  let markSubscribeStarted!: () => void;
  let resolveSubscribe!: (subscription: RuntimeEventSubscription) => void;
  const subscribeStarted = new Promise<void>((resolve) => {
    markSubscribeStarted = resolve;
  });
  let unsubscribed = false;
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.succeed(RuntimeEventBus, {
      publish: () => Effect.void,
      subscribe: Effect.promise<RuntimeEventSubscription>(
        () =>
          new Promise((resolve) => {
            markSubscribeStarted();
            resolveSubscribe = resolve;
          }),
      ),
    }),
  );

  try {
    await fastify.register(websocket);
    registerRuntimeEventsApi(fastify, runtime as never);
    await fastify.ready();

    const ws = await fastify.injectWS('/api/v1/events');
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.terminate();
    await subscribeStarted;
    await closed;
    resolveSubscribe({
      take: Effect.die('Subscription was not cleaned up before pumping events.'),
      unsubscribe: Effect.sync(() => {
        unsubscribed = true;
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(unsubscribed, true);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

function fakeEventBus() {
  return {
    publish: () => Effect.void,
    subscribe: Effect.die('subscribe is not used by origin rejection test'),
  };
}

function agentSessionChangedEvent() {
  return {
    id: 'evt_test_1',
    type: 'agent_session_changed',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: {
      agentSessionId: 1,
      worktreeId: 2,
      surfaceId: 3,
      paneId: 4,
      status: 'failed',
      statusReason: 'harness_session_id_missing',
      diagnosticCode: 'harness_session_id_missing',
    },
  } satisfies RuntimeEvent;
}

function takeMessage(ws: { once: (event: 'message', listener: (data: Buffer) => void) => void }) {
  return new Promise<RuntimeEvent>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for runtime event message.')),
      1_000,
    );
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()) as RuntimeEvent);
    });
  });
}
