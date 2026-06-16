import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { InternalRuntimeEventBus, InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import { HarnessEventTokenRegistry, HarnessEventTokenRegistryLive } from './token-registry.js';

const TestLayer = Layer.provideMerge(HarnessEventTokenRegistryLive, InternalRuntimeEventBusLive);

test('harness event token registry resolves and revokes process-scoped tokens on PTY lifecycle events', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* HarnessEventTokenRegistry;
      const internalBus = yield* InternalRuntimeEventBus;

      const token = yield* registry.create({
        agentSessionId: 10,
        ptyProcessId: 20,
        harness: 'pi',
      });
      assert.equal((yield* registry.resolve(token.token))?.agentSessionId, 10);

      yield* internalBus.publish({
        type: 'pty_process_killed',
        ptyProcessId: 20,
        status: 'killed',
        statusReason: 'user_requested',
      });
      yield* waitForRevocation(registry, token.token);
    }).pipe(Effect.provide(TestLayer)),
  );
});

function waitForRevocation(
  registry: import('./token-registry.js').HarnessEventTokenRegistryService,
  token: string,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((yield* registry.resolve(token)) === null) return;
      yield* Effect.sleep(5);
    }
    assert.fail('Timed out waiting for harness event token revocation.');
  });
}
