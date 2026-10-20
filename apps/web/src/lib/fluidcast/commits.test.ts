import assert from 'node:assert/strict';
import test from 'node:test';

import { Deferred, Effect } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type { AgentSessionMetadata, ApiError } from '@isagi/contracts';
import { RuntimeApiError } from '@isagi/runtime-client';

import { keys } from '../state/keys.js';
import { appReactivityAtom, runApp } from '../state/runtime.js';
import { flush, makeTestRegistry } from '../state/testing.js';
import {
  interactionOrigin,
  isHandoffFailure,
  pendingInteractionSwitchesAtom,
  setPaneInteraction,
} from './commits.js';

const from = { generation: 4, fluidcastSessionId: null, processIncarnation: 'pty:9' } as const;
const input = { surfaceId: 3, paneId: 7, agentSessionId: 11, mode: 'fluidcast', from } as const;

function setup(answer: Effect.Effect<{ readonly mode: 'terminal' | 'fluidcast' }, unknown>) {
  const calls: unknown[] = [];
  const registry = makeTestRegistry({
    api: {
      setAgentInteractionMode: (agentSessionId, body) =>
        Effect.suspend(() => {
          calls.push([agentSessionId, body]);
          return answer;
        }) as never,
    },
  });
  return { calls, registry };
}

function apiError(code: string): RuntimeApiError {
  return new RuntimeApiError({
    endpointId: 'agent-sessions.set-interaction-mode',
    apiError: { code, status: 500, message: 'diagnostic', requestId: 'r' } as ApiError,
  });
}

function watchKeys(registry: ReturnType<typeof makeTestRegistry>) {
  const reactivity = AsyncResult.getOrThrow(registry.get(appReactivityAtom));
  const seen: string[] = [];
  for (const key of [keys.surface(3), keys.workspace, keys.surface(4), keys.activeContext]) {
    reactivity.registerUnsafe([key], () => seen.push(key));
  }
  return seen;
}

test('a switch marks its pane pending until it lands, then re-reads the surface and workspace', async (t) => {
  const gate = Effect.runSync(Deferred.make<void>());
  const { calls, registry } = setup(
    Deferred.await(gate).pipe(Effect.as({ mode: 'fluidcast' as const })),
  );
  t.after(() => registry.dispose());
  const seen = watchKeys(registry);

  const running = runApp(registry, setPaneInteraction(input));
  await flush();
  assert.deepEqual([...registry.get(pendingInteractionSwitchesAtom)], [7]);
  assert.deepEqual(calls, [[11, { mode: 'fluidcast', from }]]);

  Effect.runSync(Deferred.succeed(gate, undefined));
  await running;

  assert.deepEqual(registry.get(pendingInteractionSwitchesAtom).size, 0);
  assert.deepEqual(seen.sort(), [keys.surface(3), keys.workspace].sort());
});

test('a failed switch clears its pending mark, re-reads the surface and workspace, and rejects with the failure', async (t) => {
  const failure = apiError('fluidcast_start_failed');
  const { registry } = setup(Effect.fail(failure));
  t.after(() => registry.dispose());
  const seen = watchKeys(registry);

  await assert.rejects(runApp(registry, setPaneInteraction(input)), (error) => error === failure);
  assert.equal(registry.get(pendingInteractionSwitchesAtom).size, 0);
  assert.deepEqual(seen.sort(), [keys.surface(3), keys.workspace].sort());
});

test('only a failure after cleanup began counts as a handoff failure', () => {
  for (const code of [
    'fluidcast_session_unreadable',
    'fluidcast_start_failed',
    'agent_terminal_stop_failed',
  ]) {
    assert.equal(isHandoffFailure(apiError(code)), true, code);
  }
  for (const code of [
    'fluidcast_unavailable',
    'agent_interaction_changed',
    'agent_session_deleting',
  ]) {
    assert.equal(isHandoffFailure(apiError(code)), false, code);
  }
  assert.equal(isHandoffFailure(new Error('fluidcast_start_failed')), false);
});

const agentSession = (
  interaction: AgentSessionMetadata['interaction'],
  processIncarnation: string | null,
) => ({ interaction, processIncarnation }) as AgentSessionMetadata;

test('a switch origin names the controller the projection shows', () => {
  assert.deepEqual(
    interactionOrigin(
      agentSession({ mode: 'terminal', generation: 2, fluidcast: 'available' }, 'pty:5'),
    ),
    { generation: 2, fluidcastSessionId: null, processIncarnation: 'pty:5' },
  );
  assert.deepEqual(
    interactionOrigin(
      agentSession({ mode: 'fluidcast', generation: 3, fluidcastSessionId: 'fc' }, null),
    ),
    { generation: 3, fluidcastSessionId: 'fc', processIncarnation: null },
  );
  assert.deepEqual(
    interactionOrigin(
      agentSession(
        {
          mode: 'fluidcast_failed',
          generation: 5,
          failure: { code: 'terminal_stop_failed', diagnostic: 'd' },
        },
        null,
      ),
    ),
    { generation: 5, fluidcastSessionId: null, processIncarnation: null },
  );
});
