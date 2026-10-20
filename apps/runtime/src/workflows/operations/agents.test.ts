import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Result } from 'effect';

import type { SurfaceDetail } from '@isagi/contracts';

import { AgentSessionError, type StopUnlessPlacedOutcome } from '../../environment/testing.js';
import { makeAgentPort, sendAgentPrompt, spawnAgentSession, type AgentDeps } from './agents.js';

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
    Effect.result(
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
  assert.ok(Result.isFailure(result));
  assert.match(
    String(result.failure),
    /was closed while agent session 5 was starting; its process 42 was stopped/,
  );
});

test('an agent moved to another pane while it launched is reported as left running there', async () => {
  const { result } = await spawnWith({ kind: 'placed', surfaceId: 9, paneId: 11 });
  assert.ok(Result.isFailure(result));
  assert.match(String(result.failure), /moved to pane 11 on surface 9 .* left running there/);
});

test('a stop that fails is reported as a failure, not as a stop', async () => {
  const { result } = await spawnWith({
    kind: 'stop_failed',
    cause: new Error('the backend refused the signal'),
  });
  assert.ok(Result.isFailure(result));
  assert.match(
    String(result.failure),
    /its process 42 could not be stopped: the backend refused the signal/,
  );
  assert.doesNotMatch(String(result.failure), /was stopped/);
});

/**
 * A send into a session whose controller is a generation counter: `switchTo` moves it, as a mode
 * change would. The observer reports the agent ready after `observerWaits` empty reads.
 */
function sendWorld(options: { readonly terminal: boolean; readonly observerWaits?: number }) {
  const log: string[] = [];
  const state = { terminal: options.terminal, generation: 4 };
  let waits = options.observerWaits ?? 0;
  const refuse = (code: 'not_in_terminal_mode' | 'interaction_changed') =>
    Effect.fail(new AgentSessionError(code, `refused: ${code}`));
  const requireTerminalMode = (_id: number, expected?: number) =>
    Effect.suspend(() => {
      log.push('requireTerminalMode');
      if (!state.terminal) return refuse('not_in_terminal_mode');
      if (expected !== undefined && expected !== state.generation)
        return refuse('interaction_changed');
      return Effect.succeed(state.generation);
    });
  const deps = {
    agents: {
      requireTerminalMode,
      withRunningTerminal: <A, E, R>(
        id: number,
        generation: number,
        use: (ptyProcessId: number) => Effect.Effect<A, E, R>,
      ) =>
        requireTerminalMode(id, generation).pipe(
          Effect.andThen(Effect.sync(() => log.push(`locked:${generation}`))),
          Effect.andThen(use(42)),
        ),
    },
    observer: {
      getProjection: () =>
        Effect.sync(() => {
          log.push('observer');
          if (waits === 0) return {};
          waits -= 1;
          // The pane switches away and back while the send waits for observation.
          state.generation += 2;
          return undefined;
        }),
      getTurnEdges: () => Effect.succeed([]),
    },
    pty: {
      writeInput: (input: { readonly ptyProcessId: number; readonly data: string }) =>
        Effect.sync(() => void log.push(`write:${input.ptyProcessId}`)),
    },
  } as unknown as AgentDeps;
  const send = sendAgentPrompt(deps, { agentSessionId: 5, prompt: 'Next step.' });
  return { log, send };
}

test('a send to an agent not in terminal mode is refused before observation or writing', async () => {
  const { log, send } = sendWorld({ terminal: false });
  const result = await Effect.runPromise(Effect.result(send));
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof AgentSessionError);
  assert.equal(result.failure.code, 'not_in_terminal_mode');
  assert.deepEqual(log, ['requireTerminalMode']);
});

test('a send writes under the generation it was admitted at, and is refused once that changed', async () => {
  const current = sendWorld({ terminal: true });
  const sent = await Effect.runPromise(current.send);
  assert.equal(sent.agentSessionId, 5);
  assert.deepEqual(current.log, [
    'requireTerminalMode',
    'observer',
    'requireTerminalMode',
    'locked:4',
    'write:42',
    'write:42',
  ]);

  const changed = sendWorld({ terminal: true, observerWaits: 1 });
  const result = await Effect.runPromise(Effect.result(changed.send));
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof AgentSessionError);
  assert.equal(result.failure.code, 'interaction_changed');
  assert.equal(
    changed.log.some((entry) => entry.startsWith('write')),
    false,
  );
});

test("a workflow's liveness reads the agent's current controller", async () => {
  const answers = [Effect.succeed(true), Effect.succeed(false), Effect.fail(new Error('gone'))];
  const port = makeAgentPort({
    agents: { isControllerLive: () => answers.shift() ?? Effect.die('unexpected read') },
  } as unknown as AgentDeps);
  const alive = await Effect.runPromise(
    Effect.all([port.isAlive(5), port.isAlive(5), port.isAlive(5)]),
  );
  assert.deepEqual(alive, [true, false, false]);
});
