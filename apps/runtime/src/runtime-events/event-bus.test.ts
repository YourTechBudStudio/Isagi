import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { RuntimeEvent } from '@isagi/contracts';

import { RuntimeEventBus, RuntimeEventBusLive } from './event-bus.js';

test('runtime event bus publishes events to subscribers', async () => {
  const event = agentSessionChangedEvent();

  const received = await Effect.runPromise(
    Effect.gen(function* () {
      const eventBus = yield* RuntimeEventBus;
      const subscription = yield* eventBus.subscribe;
      yield* eventBus.publish(event);
      const next = yield* subscription.take;
      yield* subscription.unsubscribe;
      return next;
    }).pipe(Effect.provide(RuntimeEventBusLive)),
  );

  assert.deepEqual(received, event);
});

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
