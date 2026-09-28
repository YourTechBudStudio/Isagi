import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Either } from 'effect';

import type { SurfaceDetail } from '@isagi/contracts';

import type { StopUnlessPlacedOutcome } from '../../agent-sessions/agent-sessions.service.js';
import { spawnAgentSession, type AgentDeps } from './agents.js';

/**
 * Once the process has launched, spawn has the session domain stop it unless a
 * pane holds the session: a surface closed meanwhile would otherwise leave it
 * running with no pane. These drive each answer that decision can give.
 */

const emptySurface: SurfaceDetail = {
  id: 3,
  worktreeId: 1,
  title: 'Review',
  layout: null,
  activePaneId: null,
  panes: [],
};

const placedSurface = {
  ...emptySurface,
  layout: { kind: 'leaf', nodeId: 'pane-7', paneId: 7, collapsed: false },
  activePaneId: 7,
  panes: [
    {
      id: 7,
      surfaceId: 3,
      title: 'Claude',
      sortOrder: 0,
      session: { kind: 'agent_session', agentSession: { id: 5 } },
    },
  ],
} as unknown as SurfaceDetail;

function spawnWith(outcome: StopUnlessPlacedOutcome) {
  const decisions: Array<{ readonly agentSessionId: number; readonly ptyProcessId: number }> = [];
  const reads = [Effect.succeed(emptySurface), Effect.succeed(placedSurface)];
  const deps = {
    surfaces: {
      getSurfaceDetail: () => reads.shift() ?? Effect.die('unexpected surface read'),
      startPane: () => Effect.succeed({ worktreeId: 1, surfaceId: 3, paneId: 7, title: 'Claude' }),
    },
    agents: {
      ensureActivePtyProcess: () => Effect.succeed(42),
      stopUnlessPlaced: (input: {
        readonly agentSessionId: number;
        readonly ptyProcessId: number;
      }) =>
        Effect.sync(() => {
          decisions.push(input);
          return outcome;
        }),
    },
  } as unknown as AgentDeps;

  return Effect.runPromise(
    Effect.either(
      spawnAgentSession(deps, {
        worktreeId: 1,
        surfaceId: 3,
        harness: 'claude',
        prompt: 'Review the change.',
        onCreated: () => Effect.void,
      }),
    ),
  ).then((result) => ({ result, decisions }));
}

test('spawn asks the session domain to stop its process unless the session is placed', async () => {
  const { decisions } = await spawnWith({ kind: 'stopped' });
  assert.deepEqual(decisions, [{ agentSessionId: 5, ptyProcessId: 42 }]);
});

test('an agent whose surface was closed while it launched is reported as stopped', async () => {
  const { result } = await spawnWith({ kind: 'stopped' });
  assert.ok(Either.isLeft(result));
  assert.match(
    String(result.left),
    /was closed while agent session 5 was starting; its process 42 was stopped/,
  );
});

test('an agent moved to another pane while it launched is reported as left running there', async () => {
  const { result } = await spawnWith({ kind: 'placed', surfaceId: 9, paneId: 11 });
  assert.ok(Either.isLeft(result));
  assert.match(String(result.left), /moved to pane 11 on surface 9 .* left running there/);
});

test('a stop that fails is reported as a failure, not as a stop', async () => {
  const { result } = await spawnWith({
    kind: 'stop_failed',
    cause: new Error('the backend refused the signal'),
  });
  assert.ok(Either.isLeft(result));
  assert.match(
    String(result.left),
    /its process 42 could not be stopped: the backend refused the signal/,
  );
  assert.doesNotMatch(String(result.left), /was stopped/);
});
