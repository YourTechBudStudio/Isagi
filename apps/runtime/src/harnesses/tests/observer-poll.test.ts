import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, Ref } from 'effect';
import { TestClock } from 'effect/testing';

import { runWithTestClock } from '@isagi/testing';

import { InternalEvents } from '../../platform/events/index.js';
import { AgentSessionArtifacts } from '../ledger.js';
import { HarnessObservationTargets } from '../observation-targets.js';
import { HarnessLedgerObserver } from '../observer.service.js';

test('the harness observer polls live sessions once per interval and never after its scope closes', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const livePolls = yield* Ref.make(0);
      const targets = Layer.succeed(
        HarnessObservationTargets,
        HarnessObservationTargets.of({
          list: ({ mode }) =>
            mode === 'live'
              ? Ref.update(livePolls, (count) => count + 1).pipe(Effect.as([]))
              : Effect.succeed([]),
        }),
      );
      const artifacts = Layer.mock(AgentSessionArtifacts)({
        paths: ({ agentSessionId }) => ({
          directory: `/unused/${agentSessionId}`,
          metadataPath: `/unused/${agentSessionId}/harness.json`,
        }),
        listAgentSessionIds: Effect.succeed([]),
      });
      const observer = HarnessLedgerObserver.layerNoDeps.pipe(
        Layer.provide([targets, artifacts, InternalEvents.layer]),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(observer);
          yield* TestClock.adjust('499 millis');
          assert.equal(yield* Ref.get(livePolls), 0);
          yield* TestClock.adjust('1 millis');
          assert.equal(yield* Ref.get(livePolls), 1);
          yield* TestClock.adjust('1 second');
          assert.equal(yield* Ref.get(livePolls), 3);
        }),
      );

      yield* TestClock.adjust('10 seconds');
      assert.equal(yield* Ref.get(livePolls), 3);
    }),
  ));
