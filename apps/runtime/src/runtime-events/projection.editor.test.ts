import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, Logger } from 'effect';

import type { RuntimeEvent } from '@isagi/contracts';

import {
  AgentSessionAttentionProjection,
  AgentSessionRepository,
} from '../agent-sessions/index.js';
import { DatabaseError } from '../persistence/index.js';
import { SurfaceRepository, type SurfaceRepositoryService } from '../surfaces/index.js';
import { TerminalSessionRepository } from '../terminal-sessions/index.js';
import { RuntimeEventBus, type RuntimeEventBusService } from './event-bus.js';
import { InternalRuntimeEventBus, InternalRuntimeEventBusLive } from './internal-event-bus.js';
import { RuntimeEventProjectionLive } from './projection.service.js';

/**
 * The projection is given only `SurfaceRepository`, which is exactly why the
 * public editor payload is identity plus placement and nothing more: this layer
 * cannot read editor facts, because they live in the editor service's memory.
 * Every other dependency below dies if touched, which is what proves the editor
 * branch reads nothing else.
 */
function dying<T>(label: string): T {
  return new Proxy({} as object, {
    get: () => Effect.die(`${label} is not used by the editor projection`),
  }) as T;
}

type Placement = { worktreeId: number; surfaceId: number; paneId: number };

function harness(input: {
  readonly placement: Effect.Effect<Placement | null, DatabaseError>;
  readonly published: RuntimeEvent[];
}) {
  const surfaces = Layer.succeed(SurfaceRepository, {
    findPaneForSession: () => input.placement,
  } as unknown as SurfaceRepositoryService);
  const publicBus = Layer.succeed(RuntimeEventBus, {
    publish: (event: RuntimeEvent) => Effect.sync(() => void input.published.push(event)),
    subscribe: Effect.die('the editor projection test never subscribes publicly'),
  } as unknown as RuntimeEventBusService);
  return RuntimeEventProjectionLive.pipe(
    Layer.provideMerge(InternalRuntimeEventBusLive),
    Layer.provide(surfaces),
    Layer.provide(publicBus),
    Layer.provide(Layer.succeed(AgentSessionRepository, dying('agents'))),
    Layer.provide(Layer.succeed(TerminalSessionRepository, dying('terminals'))),
    Layer.provide(Layer.succeed(AgentSessionAttentionProjection, dying('attention'))),
  );
}

async function runProjection(placement: Effect.Effect<Placement | null, DatabaseError>) {
  const published: RuntimeEvent[] = [];
  const logged: string[] = [];
  const capture = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ message }) => void logged.push(String(message))),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const internal = yield* InternalRuntimeEventBus;
        yield* internal.publish({ type: 'editor_context_changed', editorContextId: 42 });
        // The subscriber is a forked loop; give it turns to drain.
        yield* Effect.sleep('25 millis');
      }).pipe(Effect.provide(harness({ placement, published })), Effect.provide(capture)),
    ),
  );
  return { published, logged };
}

test('a placed editor context publishes exactly one public event carrying identity and placement', async () => {
  const { published, logged } = await runProjection(
    Effect.succeed({ worktreeId: 3, surfaceId: 9, paneId: 17 }),
  );

  assert.deepEqual(logged, []);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0]?.type, 'editor_context_changed');
  assert.deepEqual(published[0] && 'payload' in published[0] ? published[0].payload : null, {
    editorContextId: 42,
    worktreeId: 3,
    surfaceId: 9,
    paneId: 17,
  });
});

test('an unplaced editor context publishes nothing at all', async () => {
  const { published, logged } = await runProjection(Effect.succeed(null));

  // Not a partial event, and deliberately not an `attention_source_removed`:
  // editors have no turn lifecycle and are not in the attention vocabulary. The
  // case is reachable and normal — surface deletion removes placement and then
  // publishes `surface_changed`, which is what the client acts on.
  assert.deepEqual(published, []);
  // A genuine absence is not a problem, so it leaves no diagnostic behind.
  assert.deepEqual(logged, []);
});

test('a failed placement lookup drops the event but leaves a diagnostic breadcrumb', async () => {
  const { published, logged } = await runProjection(
    Effect.fail(new DatabaseError({ operation: 'findPaneForSession', cause: new Error('boom') })),
  );

  // The subscriber survives: a failed read degrades one projection rather than
  // tearing down the loop that serves every other event.
  assert.deepEqual(published, []);
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? '', /lookup=editor_context_placement/);
  assert.match(logged[0] ?? '', /entityId=42/);
  assert.match(logged[0] ?? '', /cause=Database operation findPaneForSession failed/);
});
