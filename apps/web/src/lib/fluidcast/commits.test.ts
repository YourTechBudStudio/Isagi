import assert from 'node:assert/strict';
import test from 'node:test';

import { Deferred, Effect } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import { keys } from '../state/keys.js';
import { appReactivityAtom, runApp } from '../state/runtime.js';
import { flush, makeTestRegistry } from '../state/testing.js';
import { pendingInteractionSwitchesAtom, setPaneInteraction } from './commits.js';

const input = { surfaceId: 3, paneId: 7, agentSessionId: 11, mode: 'fluidcast' } as const;

function setup(answer: Effect.Effect<{ readonly mode: 'terminal' | 'fluidcast' }, never>) {
  const calls: Array<readonly [number, string]> = [];
  const registry = makeTestRegistry({
    api: {
      setAgentInteractionMode: (agentSessionId, mode) =>
        Effect.suspend(() => {
          calls.push([agentSessionId, mode]);
          return answer;
        }) as never,
    },
  });
  return { calls, registry };
}

test('a switch marks its pane pending until it lands, then re-reads the surface and workspace', async (t) => {
  const gate = Effect.runSync(Deferred.make<void>());
  const { calls, registry } = setup(
    Deferred.await(gate).pipe(Effect.as({ mode: 'fluidcast' as const })),
  );
  t.after(() => registry.dispose());
  const reactivity = AsyncResult.getOrThrow(registry.get(appReactivityAtom));
  const seen: string[] = [];
  for (const key of [keys.surface(3), keys.workspace, keys.surface(4), keys.activeContext]) {
    reactivity.registerUnsafe([key], () => seen.push(key));
  }

  const running = runApp(registry, setPaneInteraction(input));
  await flush();
  assert.deepEqual([...registry.get(pendingInteractionSwitchesAtom)], [7]);
  assert.deepEqual(calls, [[11, 'fluidcast']]);

  Effect.runSync(Deferred.succeed(gate, undefined));
  await running;

  assert.deepEqual(registry.get(pendingInteractionSwitchesAtom).size, 0);
  assert.deepEqual(seen.sort(), [keys.surface(3), keys.workspace].sort());
});

test('a failed switch clears its pending mark and rejects with the failure', async (t) => {
  const failure = new Error('refused');
  const { registry } = setup(Effect.die(failure) as never);
  t.after(() => registry.dispose());

  await assert.rejects(runApp(registry, setPaneInteraction(input)));
  assert.equal(registry.get(pendingInteractionSwitchesAtom).size, 0);
});
