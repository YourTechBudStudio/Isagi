import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type { AgentSessionInteraction, SurfaceDetail, SurfacePane } from '@isagi/contracts';
import { RuntimeApiError, RuntimeTransportError } from '@isagi/runtime-client';

import { runApp } from '../state/runtime.js';
import { makeTestRegistry } from '../state/testing.js';
import {
  leftPresentation,
  nextPresented,
  nothingPresented,
  pauseHiddenSession,
  presentedFluidcastSessions,
  type Presented,
} from './presentation.js';

function agentPane(id: number, interaction: AgentSessionInteraction): SurfacePane {
  return {
    id,
    surfaceId: 1,
    title: `agent ${id}`,
    sortOrder: id,
    session: {
      kind: 'agent_session',
      agentSession: {
        id,
        paneId: id,
        worktreeId: 1,
        harness: 'claude',
        cwd: '/tmp/worktree',
        harnessSessionId: null,
        statusReason: null,
        recoveryAction: 'connect_existing',
        interaction,
        status: 'running',
        processIncarnation: interaction.mode === 'terminal' ? `pty:${id}` : null,
        diagnosticCode: null,
        diagnosticDetail: null,
        createdAt: '2026-06-17T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
        lastSeenAt: null,
      },
    },
  };
}

const fluidcast = (fluidcastSessionId: string): AgentSessionInteraction => ({
  mode: 'fluidcast',
  generation: 1,
  fluidcastSessionId,
});
const terminal: AgentSessionInteraction = {
  mode: 'terminal',
  generation: 0,
  fluidcast: 'available',
};

function detail(surfaceId: number, panes: readonly SurfacePane[]): SurfaceDetail {
  return {
    id: surfaceId,
    worktreeId: 1,
    title: `s${surfaceId}`,
    layout: null,
    activePaneId: null,
    panes,
  };
}

const loaded = (value: SurfaceDetail) => AsyncResult.success<SurfaceDetail, Error>(value);
const refetching = (value: SurfaceDetail) =>
  AsyncResult.success<SurfaceDetail, Error>(value, { waiting: true });
const initial = AsyncResult.initial<SurfaceDetail, Error>();

const surfaceA = detail(1, [
  agentPane(1, fluidcast('a1')),
  agentPane(2, fluidcast('a2')),
  agentPane(3, terminal),
]);
const surfaceB = detail(2, [agentPane(4, fluidcast('b1'))]);

/** Feeds `steps` through the presentation diff, collecting every pause it would send. */
function pausesFor(
  steps: ReadonlyArray<readonly [number | null, AsyncResult.AsyncResult<SurfaceDetail, Error>]>,
) {
  let presented: Presented = nothingPresented;
  const sent: string[] = [];
  for (const [surfaceId, result] of steps) {
    const next = nextPresented(presented, surfaceId, result);
    sent.push(...leftPresentation(presented, next));
    presented = next;
  }
  return { sent, presented };
}

test('the presented set is the surface’s Fluidcast-mode agent panes', () => {
  assert.deepEqual([...presentedFluidcastSessions(surfaceA)].sort(), ['a1', 'a2']);
});

test('a surface switch pauses exactly the sessions that left', () => {
  const { sent } = pausesFor([
    [1, loaded(surfaceA)],
    [2, initial],
    [2, loaded(surfaceB)],
  ]);

  assert.deepEqual(sent.sort(), ['a1', 'a2']);
});

test('a worktree switch (or no active surface) pauses every session of the previous surface', () => {
  assert.deepEqual(
    pausesFor([
      [1, loaded(surfaceA)],
      [null, initial],
    ]).sent.sort(),
    ['a1', 'a2'],
  );
});

test('returning to a surface whose detail is cached presents it at once and pauses the other', () => {
  const { sent, presented } = pausesFor([
    [1, loaded(surfaceA)],
    [2, loaded(surfaceB)],
    [1, loaded(surfaceA)],
  ]);

  assert.deepEqual(sent.sort(), ['a1', 'a2', 'b1']);
  assert.deepEqual([...presented.ids].sort(), ['a1', 'a2']);
});

test('a refetch, a failed read or an Initial on the same surface pauses nothing', () => {
  const failed = AsyncResult.failure<SurfaceDetail, Error>(new Error('x') as never);
  const { sent } = pausesFor([
    [1, loaded(surfaceA)],
    [1, refetching(surfaceA)],
    [1, failed as AsyncResult.AsyncResult<SurfaceDetail, Error>],
    [1, initial],
  ]);

  assert.deepEqual(sent, []);
});

test('re-running the diff on unchanged inputs (StrictMode, zen, focus) sends nothing', () => {
  const { sent } = pausesFor([
    [1, loaded(surfaceA)],
    [1, loaded(surfaceA)],
    [1, loaded(surfaceA)],
  ]);

  assert.deepEqual(sent, []);
});

test('a pane switched back to terminal on the visible surface leaves the set', () => {
  const switched = detail(1, [agentPane(1, terminal), agentPane(2, fluidcast('a2'))]);

  assert.deepEqual(
    pausesFor([
      [1, loaded(surfaceA)],
      [1, loaded(switched)],
    ]).sent,
    ['a1'],
  );
});

const pauseSent = (fail?: () => unknown) => {
  const calls: Array<{ readonly id: string; readonly command: unknown }> = [];
  const registry = makeTestRegistry({
    api: {
      sendFluidcastCommand: (id, command) =>
        Effect.suspend(() => {
          calls.push({ id, command });
          return fail ? Effect.fail(fail() as never) : Effect.succeed(null);
        }),
    },
  });
  return { calls, registry };
};

const apiError = (code: string, status: number) =>
  new RuntimeApiError({
    endpointId: 'fluidcast.command',
    apiError: { code, status, message: 'x', requestId: 'r' } as never,
  });

test('the hide pause sends Pause to its own session', async (t) => {
  const { calls, registry } = pauseSent();
  t.after(() => registry.dispose());

  await runApp(registry, pauseHiddenSession('a1'));

  assert.deepEqual(calls, [{ id: 'a1', command: { _tag: 'Pause' } }]);
});

for (const code of ['fluidcast_session_not_found', 'fluidcast_command_rejected'] as const) {
  test(`${code} from a hide pause is ignored`, async (t) => {
    const { registry } = pauseSent(() => apiError(code, code.endsWith('not_found') ? 404 : 409));
    t.after(() => registry.dispose());

    await runApp(registry, pauseHiddenSession('a1'));
  });
}

test('any other hide-pause failure is logged with the session ID', async (t) => {
  const { registry } = pauseSent(
    () => new RuntimeTransportError({ endpointId: 'fluidcast.command', cause: new Error('down') }),
  );
  t.after(() => registry.dispose());
  const warn = t.mock.method(console, 'warn', () => undefined);
  const log = t.mock.method(console, 'log', () => undefined);

  await runApp(registry, pauseHiddenSession('a1'));

  const lines = [...warn.mock.calls, ...log.mock.calls].map((call) =>
    call.arguments.map((argument) => JSON.stringify(argument) ?? String(argument)).join(' '),
  );
  assert.ok(
    lines.some((line) => line.includes('hide pause failed') && line.includes('a1')),
    lines.join('\n'),
  );
});
