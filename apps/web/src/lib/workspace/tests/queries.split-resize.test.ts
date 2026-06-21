import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import type { SetSplitWeightsOutput } from '@isagi/contracts';

import { setSplitWeightsFromSurface } from '../queries.js';
import { surfaceDetailQueryKey } from '../query-keys.js';

test('split resize commit writes the returned layout into the surface cache', async () => {
  const client = new QueryClient();
  client.setQueryData(surfaceDetailQueryKey(700), {
    id: 700,
    layout: splitWeightsOutput(700, [0.5, 0.5]).layout,
  });

  await setSplitWeightsFromSurface({
    surfaceId: 700,
    weights: { nodeId: 'split-1', weights: [0.3, 0.7] },
    client,
    commit: (surfaceId, weights) => Promise.resolve(splitWeightsOutput(surfaceId, weights.weights)),
  });

  assert.deepEqual(cachedSurfaceWeights(client, 700), [0.3, 0.7]);
});

test('split resize commit invalidates the surface detail when the commit fails', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  client.setQueryData(surfaceDetailQueryKey(701), {
    id: 701,
    layout: splitWeightsOutput(701, [0.5, 0.5]).layout,
  });
  const commitError = new Error('resize commit failed');

  await assert.rejects(
    () =>
      setSplitWeightsFromSurface({
        surfaceId: 701,
        weights: { nodeId: 'split-1', weights: [0.3, 0.7] },
        client,
        commit: () => Promise.reject(commitError),
      }),
    { message: commitError.message },
  );

  // The corrective refetch is armed and the cache layout is left untouched for it.
  assert.equal(client.getQueryState(surfaceDetailQueryKey(701))?.isInvalidated, true);
  assert.deepEqual(cachedSurfaceWeights(client, 701), [0.5, 0.5]);
});

test('split resize keeps the newest layout when an older commit response lands last', async () => {
  const client = new QueryClient();
  client.setQueryData(surfaceDetailQueryKey(702), {
    id: 702,
    layout: splitWeightsOutput(702, [0.5, 0.5]).layout,
  });

  const pending: Array<(output: SetSplitWeightsOutput) => void> = [];
  const defer = () =>
    new Promise<SetSplitWeightsOutput>((resolve) => {
      pending.push(resolve);
    });

  const older = setSplitWeightsFromSurface({
    surfaceId: 702,
    weights: { nodeId: 'split-1', weights: [0.3, 0.7] },
    client,
    commit: defer,
  });
  const newer = setSplitWeightsFromSurface({
    surfaceId: 702,
    weights: { nodeId: 'split-1', weights: [0.8, 0.2] },
    client,
    commit: defer,
  });

  // The newer commit resolves first; the older (now stale) one lands last and must
  // not overwrite the newer intent.
  pending[1]!(splitWeightsOutput(702, [0.8, 0.2]));
  await newer;
  pending[0]!(splitWeightsOutput(702, [0.3, 0.7]));
  await older;

  assert.deepEqual(cachedSurfaceWeights(client, 702), [0.8, 0.2]);
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

function cachedSurfaceWeights(client: QueryClient, surfaceId: number) {
  return (
    client.getQueryData(surfaceDetailQueryKey(surfaceId)) as
      | { readonly layout: { readonly weights: readonly number[] } }
      | undefined
  )?.layout.weights;
}
