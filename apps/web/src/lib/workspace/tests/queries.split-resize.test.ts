import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Effect, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type { SetSplitWeightsOutput, SurfaceDetail } from '@isagi/contracts';

import { peek } from '../../state/policy.js';
import { runApp } from '../../state/runtime.js';
import { controllable, flush, makeTestRegistry } from '../../state/testing.js';
import { setSplitWeightsFromSurface } from '../commits.js';
import { surfaceDetailAtom } from '../queries.js';
import { refuse } from './test-support.js';

/** A session holding surface `surfaceId` at even weights; counts its detail reads. */
async function surfaceSession(t: TestContext, surfaceId: number) {
  let detailReads = 0;
  const registry = makeTestRegistry({
    retry: false,
    api: {
      getSurfaceDetail: (id) =>
        Effect.sync(() => {
          detailReads += 1;
          return { id, layout: splitWeightsOutput(id, [0.5, 0.5]).layout } as SurfaceDetail;
        }),
    },
  });
  t.after(() => registry.dispose());
  t.after(registry.mount(surfaceDetailAtom(surfaceId)));
  await flush();
  return { registry, detailReads: () => detailReads };
}

test('split resize commit writes the returned layout into the surface cache', async (t) => {
  const { registry } = await surfaceSession(t, 700);

  await runApp(
    registry,
    setSplitWeightsFromSurface({
      surfaceId: 700,
      weights: { nodeId: 'split-1', weights: [0.3, 0.7] },
      commit: (surfaceId, weights) =>
        Effect.succeed(splitWeightsOutput(surfaceId, weights.weights)),
    }),
  );

  assert.deepEqual(cachedSurfaceWeights(registry, 700), [0.3, 0.7]);
});

test('split resize commit invalidates the surface detail when the commit fails', async (t) => {
  const { registry, detailReads } = await surfaceSession(t, 701);
  const commitError = 'resize commit failed';

  await assert.rejects(
    () =>
      runApp(
        registry,
        setSplitWeightsFromSurface({
          surfaceId: 701,
          weights: { nodeId: 'split-1', weights: [0.3, 0.7] },
          commit: () => refuse(commitError),
        }),
      ),
    { message: commitError },
  );

  // The corrective re-read ran and the cache layout was left untouched for it.
  assert.equal(detailReads(), 2);
  assert.deepEqual(cachedSurfaceWeights(registry, 701), [0.5, 0.5]);
});

test('split resize keeps the newest layout when an older commit response lands last', async (t) => {
  const { registry } = await surfaceSession(t, 702);
  const commits = controllable<SetSplitWeightsOutput>();

  const older = runApp(
    registry,
    setSplitWeightsFromSurface({
      surfaceId: 702,
      weights: { nodeId: 'split-1', weights: [0.3, 0.7] },
      commit: () => commits.effect,
    }),
  );
  const newer = runApp(
    registry,
    setSplitWeightsFromSurface({
      surfaceId: 702,
      weights: { nodeId: 'split-1', weights: [0.8, 0.2] },
      commit: () => commits.effect,
    }),
  );
  await flush();

  // The newer commit resolves first; the older (now stale) one lands last and must
  // not overwrite the newer intent.
  commits.calls[1]!.resolve(splitWeightsOutput(702, [0.8, 0.2]));
  await newer;
  commits.calls[0]!.resolve(splitWeightsOutput(702, [0.3, 0.7]));
  await older;

  assert.deepEqual(cachedSurfaceWeights(registry, 702), [0.8, 0.2]);
});

function splitWeightsOutput(surfaceId: number, weights: readonly number[]): SetSplitWeightsOutput {
  return {
    surfaceId,
    layout: {
      kind: 'split',
      nodeId: 'split-1',
      axis: 'row',
      sizing: 'manual',
      children: [
        { kind: 'leaf', nodeId: 'pane-1', paneId: 1, collapsed: false },
        { kind: 'leaf', nodeId: 'pane-2', paneId: 2, collapsed: false },
      ],
      weights,
    },
  };
}

function cachedSurfaceWeights(registry: ReturnType<typeof makeTestRegistry>, surfaceId: number) {
  const detail = Option.getOrUndefined(
    Option.flatMap(peek(registry, surfaceDetailAtom(surfaceId)), AsyncResult.value),
  );
  return (detail?.layout as { readonly weights?: readonly number[] } | undefined)?.weights;
}
