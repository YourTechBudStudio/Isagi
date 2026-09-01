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
import type { AgentSessionRow, TerminalSessionRow } from '../surfaces/types.js';
import { TerminalSessionRepository } from '../terminal-sessions/index.js';
import { RuntimeEventBus, type RuntimeEventBusService } from './event-bus.js';
import { InternalRuntimeEventBus, InternalRuntimeEventBusLive } from './internal-event-bus.js';
import { RuntimeEventProjectionLive } from './projection.service.js';

/**
 * These tests exist for one product rule: `attention_source_removed` is a claim
 * that a session stopped needing the user, and the client acts on it by deleting
 * the source from its attention store. Only a *confirmed* absence may make that
 * claim. A failed read is not evidence of anything, and must leave the client's
 * last known-good attention untouched.
 */
function failingRead() {
  return new DatabaseError({ operation: 'select', cause: new Error('boom') });
}

// Reached only after a placement lookup that these tests always fail first, so
// no field below is ever read.
const stubAgentRow = { id: 7, worktreeId: 1 } as unknown as AgentSessionRow;
const stubTerminalRow = { id: 7, worktreeId: 1 } as unknown as TerminalSessionRow;

function dying<T>(label: string): T {
  return new Proxy({} as object, {
    get: () => Effect.die(`${label} is not used by this projection path`),
  }) as T;
}

/** Answers each successive call with the next scripted result. */
function scripted<A>(results: readonly Effect.Effect<A | null, DatabaseError>[]) {
  let index = 0;
  return () => results[index++] ?? Effect.die('the projection made an unscripted lookup');
}

function harness(input: {
  readonly rows: () => Effect.Effect<unknown, DatabaseError>;
  readonly placements: () => Effect.Effect<unknown, DatabaseError>;
  readonly published: RuntimeEvent[];
  readonly kind: 'agent_session' | 'terminal_session';
}) {
  const repository = {
    find: input.rows,
    findByActivePtyProcessId: input.rows,
  };
  const publicBus = Layer.succeed(RuntimeEventBus, {
    publish: (event: RuntimeEvent) => Effect.sync(() => void input.published.push(event)),
    subscribe: Effect.die('this test never subscribes publicly'),
  } as unknown as RuntimeEventBusService);
  return RuntimeEventProjectionLive.pipe(
    Layer.provideMerge(InternalRuntimeEventBusLive),
    Layer.provide(
      Layer.succeed(SurfaceRepository, {
        findPaneForSession: input.placements,
      } as unknown as SurfaceRepositoryService),
    ),
    Layer.provide(publicBus),
    Layer.provide(
      Layer.succeed(
        AgentSessionRepository,
        (input.kind === 'agent_session' ? repository : dying('agents')) as never,
      ),
    ),
    Layer.provide(
      Layer.succeed(
        TerminalSessionRepository,
        (input.kind === 'terminal_session' ? repository : dying('terminals')) as never,
      ),
    ),
    Layer.provide(Layer.succeed(AgentSessionAttentionProjection, dying('attention'))),
  );
}

async function runProjection(input: {
  readonly kind: 'agent_session' | 'terminal_session';
  readonly rows: () => Effect.Effect<unknown, DatabaseError>;
  readonly placements: () => Effect.Effect<unknown, DatabaseError>;
  readonly events: number;
}) {
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
        for (let index = 0; index < input.events; index += 1) {
          yield* internal.publish(
            input.kind === 'agent_session'
              ? { type: 'agent_session_changed', agentSessionId: 7 }
              : { type: 'terminal_session_changed', terminalSessionId: 7 },
          );
        }
        // The subscriber is a forked loop; give it turns to drain.
        yield* Effect.sleep('25 millis');
      }).pipe(Effect.provide(harness({ ...input, published })), Effect.provide(capture)),
    ),
  );
  return { published, logged };
}

for (const kind of ['agent_session', 'terminal_session'] as const) {
  const stubRow = kind === 'agent_session' ? stubAgentRow : stubTerminalRow;

  test(`a failed ${kind} row lookup removes no attention, and the loop keeps serving`, async () => {
    const { published, logged } = await runProjection({
      kind,
      // First event fails the read; the second confirms the row is really gone.
      rows: scripted([Effect.fail(failingRead()), Effect.succeed(null)]),
      placements: () => Effect.die('a failed row lookup must not reach placement'),
      events: 2,
    });

    // Exactly one removal, from the confirmed absence — never from the failure.
    assert.deepEqual(
      published.map((event) => event.type),
      ['attention_source_removed'],
    );
    assert.deepEqual(published[0] && 'payload' in published[0] ? published[0].payload : null, {
      source: { kind, id: 7 },
    });
    // The second event proves the subscriber survived the failed read.
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? '', new RegExp(`lookup=${kind}_row`));
    assert.match(logged[0] ?? '', /entityId=7/);
  });

  test(`a failed ${kind} placement lookup removes no attention`, async () => {
    const { published, logged } = await runProjection({
      kind,
      rows: () => Effect.succeed(stubRow),
      placements: scripted([Effect.fail(failingRead())]),
      events: 1,
    });

    // The row exists and is placed somewhere; we simply could not read where. A
    // removal here would tell the user a live session stopped needing them.
    assert.deepEqual(published, []);
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? '', new RegExp(`lookup=${kind}_placement`));
    assert.match(logged[0] ?? '', /cause=Database operation select failed/);
  });
}
