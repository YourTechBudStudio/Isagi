import assert from 'node:assert/strict';
import test from 'node:test';

import websocket from '@fastify/websocket';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import Fastify from 'fastify';

import type { RuntimeEvent } from '@isagi/contracts';

import { makeLogCapture } from '../../test/test-support.js';
import { AgentSessionAttentionProjection } from '../environment/index.js';
import { RuntimeEvents } from '../platform/events/index.js';
import { installAllowedOrigins } from '../platform/http/index.js';
import { registerRuntimeEventsRoutes } from './api.js';

test('runtime events websocket streams published events through the contract path', async () => {
  const event = agentSessionChangedEvent();
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(RuntimeEvents.layer);

  try {
    await fastify.register(websocket);
    registerRuntimeEventsRoutes(fastify, runtime as never);
    await fastify.ready();

    const ws = await fastify.injectWS('/api/v1/events');
    try {
      await new Promise((resolve) => setImmediate(resolve));
      await runtime.runPromise(
        Effect.gen(function* () {
          const eventBus = yield* RuntimeEvents;
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
      RuntimeEvents.layer,
      Layer.succeed(AgentSessionAttentionProjection, {
        agentSessionAttention: () => Effect.succeed('idle' as const),
        terminalSessionAttention: () => 'idle' as const,
        workingAgentCount: Effect.succeed(0),
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
    registerRuntimeEventsRoutes(fastify, runtime as never);
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
  installAllowedOrigins(fastify, ['http://127.0.0.1:43129']);
  const runtime = ManagedRuntime.make(Layer.succeed(RuntimeEvents, fakeEventBus()));

  try {
    await fastify.register(websocket);
    registerRuntimeEventsRoutes(fastify, runtime as never);
    await fastify.ready();

    await assert.rejects(
      fastify.injectWS('/api/v1/events', {
        headers: { origin: 'http://127.0.0.1:43130' },
      }),
    );
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('runtime events websocket accepts the explicitly configured packaged file origin', async () => {
  const fastify = Fastify({ logger: false });
  installAllowedOrigins(fastify, ['file://']);
  const runtime = ManagedRuntime.make(RuntimeEvents.layer);

  try {
    await fastify.register(websocket);
    registerRuntimeEventsRoutes(fastify, runtime as never);
    await fastify.ready();

    const ws = await fastify.injectWS('/api/v1/events', {
      headers: { origin: 'file://' },
    });
    ws.terminate();
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('unsubscribing on socket close removes the subscriber; publish after shutdown is a no-op', async () => {
  const subscribers = { active: 0 };
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(countingRuntimeEvents(subscribers));

  try {
    await fastify.register(websocket);
    registerRuntimeEventsRoutes(fastify, runtime as never);
    await fastify.ready();

    const ws = await fastify.injectWS('/api/v1/events');
    await waitUntil(() => subscribers.active === 1, 'the connection subscribes');
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.terminate();
    await closed;
    await waitUntil(() => subscribers.active === 0, 'closing the socket removes the subscriber');

    const eventBus = await runtime.runPromise(Effect.service(RuntimeEvents));
    await fastify.close();
    await runtime.dispose();
    // The bus is shut down with the runtime; a late publisher neither fails nor is interrupted.
    await Effect.runPromise(eventBus.publish(agentSessionChangedEvent()));
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('server shutdown with an open events socket closes it without failure logs', async () => {
  const subscribers = { active: 0 };
  const logs = makeLogCapture();
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(countingRuntimeEvents(subscribers), logs.layer),
  );

  try {
    // An injected socket never ends its stream after a server-initiated closing handshake, so the server would hold
    // its 30-second close timer (and the test process) open; the handshake itself completes immediately.
    await fastify.register(websocket, { options: { closeTimeout: 50 } });
    registerRuntimeEventsRoutes(fastify, runtime as never);
    await fastify.ready();

    const ws = await fastify.injectWS('/api/v1/events');
    await waitUntil(() => subscribers.active === 1, 'the connection subscribes');
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));

    await fastify.close();
    await runtime.dispose();

    await closed;
    await waitUntil(() => subscribers.active === 0, 'shutdown removes the subscriber');
    assert.deepEqual(
      logs.lines.filter((line) => line.level === 'Warn' || line.level === 'Error'),
      [],
    );
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('a defect answering a snapshot request is logged and closes the socket so the client reconnects', async () => {
  const logs = makeLogCapture();
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      RuntimeEvents.layer,
      Layer.succeed(AgentSessionAttentionProjection, {
        agentSessionAttention: () => Effect.succeed('idle' as const),
        terminalSessionAttention: () => 'idle' as const,
        workingAgentCount: Effect.succeed(0),
        listAttentionSources: Effect.die(new Error('attention projection bug')),
      }),
      logs.layer,
    ),
  );

  try {
    // The server closes this socket; a short close timeout ends the injected stream after the handshake.
    await fastify.register(websocket, { options: { closeTimeout: 50 } });
    registerRuntimeEventsRoutes(fastify, runtime as never);
    await fastify.ready();

    const ws = await fastify.injectWS('/api/v1/events');
    try {
      const closed = waitForClose(ws);
      ws.send(JSON.stringify({ type: 'attention_snapshot_requested' }));
      await closed;

      const failures = logs.lines.filter((line) => line.level === 'Error');
      assert.equal(failures.length, 1, JSON.stringify(logs.lines));
      assert.equal(failures[0]?.message, 'Runtime event websocket client message failed');
      assert.match(failures[0]?.cause ?? '', /attention projection bug/);
    } finally {
      ws.terminate();
    }
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('a defect delivering an event is logged and closes the socket so the client reconnects', async () => {
  const logs = makeLogCapture();
  const fastify = Fastify({ logger: false });
  // The real bus, whose subscription stream dies on the first event it delivers.
  const dyingRuntimeEvents = Layer.effect(
    RuntimeEvents,
    Effect.gen(function* () {
      const bus = yield* RuntimeEvents;
      return RuntimeEvents.of({
        publish: bus.publish,
        subscribe: Effect.map(
          bus.subscribe,
          Stream.mapEffect(() => Effect.die(new Error('event delivery bug'))),
        ),
      });
    }),
  ).pipe(Layer.provide(RuntimeEvents.layer));
  const runtime = ManagedRuntime.make(Layer.mergeAll(dyingRuntimeEvents, logs.layer));

  try {
    await fastify.register(websocket, { options: { closeTimeout: 50 } });
    registerRuntimeEventsRoutes(fastify, runtime as never);
    await fastify.ready();

    const ws = await fastify.injectWS('/api/v1/events');
    try {
      const closed = waitForClose(ws);
      await new Promise((resolve) => setImmediate(resolve));
      await runtime.runPromise(
        Effect.gen(function* () {
          const eventBus = yield* RuntimeEvents;
          yield* eventBus.publish(agentSessionChangedEvent());
        }),
      );
      await closed;

      const failures = logs.lines.filter((line) => line.level === 'Error');
      assert.equal(failures.length, 1, JSON.stringify(logs.lines));
      assert.equal(failures[0]?.message, 'Runtime event websocket delivery failed');
      assert.match(failures[0]?.cause ?? '', /event delivery bug/);
    } finally {
      ws.terminate();
    }
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('runtime events websocket streams a suspended command_changed through the contract path', async () => {
  // The widened status rides the existing event: no new event type, no envelope
  // change, and the client decodes it or the test fails at the boundary.
  const event = {
    id: 'evt_test_2',
    type: 'command_changed',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: { worktreeId: 10, commandName: 'dev', status: 'suspended' },
  } satisfies RuntimeEvent;
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(RuntimeEvents.layer);

  try {
    await fastify.register(websocket);
    registerRuntimeEventsRoutes(fastify, runtime as never);
    await fastify.ready();

    const ws = await fastify.injectWS('/api/v1/events');
    try {
      await new Promise((resolve) => setImmediate(resolve));
      await runtime.runPromise(
        Effect.gen(function* () {
          const eventBus = yield* RuntimeEvents;
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

function fakeEventBus() {
  return RuntimeEvents.of({
    publish: () => Effect.void,
    subscribe: Effect.die('subscribe is not used by origin rejection test'),
  });
}

/** The real bus, counting live subscriptions: each one ends when the scope it was taken in closes. */
function countingRuntimeEvents(subscribers: { active: number }) {
  return Layer.effect(
    RuntimeEvents,
    Effect.gen(function* () {
      const bus = yield* RuntimeEvents;
      return RuntimeEvents.of({
        publish: bus.publish,
        subscribe: Effect.gen(function* () {
          subscribers.active += 1;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              subscribers.active -= 1;
            }),
          );
          return yield* bus.subscribe;
        }),
      });
    }),
  ).pipe(Layer.provide(RuntimeEvents.layer));
}

async function waitUntil(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting until ${what}.`);
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
      statusReason: 'harness_metadata_missing',
      diagnosticCode: 'harness_metadata_missing',
    },
  } satisfies RuntimeEvent;
}

/** Resolves once the client side of an injected socket has closed; fails after a second. */
function waitForClose(ws: {
  readonly readyState: number;
  once: (event: 'close', listener: () => void) => void;
}) {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState === 3) {
      resolve();
      return;
    }
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for the runtime events socket to close.')),
      1_000,
    );
    ws.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
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
