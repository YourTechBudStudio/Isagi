import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { collectPages } from '../pages.js';
import { fakeRuntime, onlyJsonDocument, runIsagi } from '../testing/cli-harness.js';

const checkpoint = { checkpointId: 'wcp_1', runId: 42 };

function pagedRoute(
  pages: Record<string, { checkpointId: string; entries: unknown[]; nextCursor: string | null }>,
) {
  return (_params: unknown, query: { cursor?: string; limit?: number }) =>
    pages[query.cursor ?? 'first'];
}

test('collectPages follows nextCursor at the contract maximum until it is null', async () => {
  const seen: unknown[] = [];
  const items = await Effect.runPromise(
    collectPages(
      (query) => {
        seen.push(query);
        const next = query.cursor === undefined ? 'b' : query.cursor === 'b' ? 'c' : null;
        return Effect.succeed({ items: [query.cursor ?? 'a'], nextCursor: next });
      },
      (page) => page.items,
    ),
  );
  assert.deepEqual(items, ['a', 'b', 'c']);
  assert.deepEqual(seen, [
    { limit: 500 },
    { cursor: 'b', limit: 500 },
    { cursor: 'c', limit: 500 },
  ]);
});

test('collectPages fails on a repeated cursor instead of looping', async () => {
  const failure = await Effect.runPromise(
    Effect.flip(
      collectPages(
        () => Effect.succeed({ items: [1], nextCursor: 'same' }),
        (page) => page.items,
      ),
    ),
  );
  assert.equal(failure._tag, 'CliFailure');
  assert.equal(
    (failure as { document: { code: string } }).document.code,
    'runtime_response_invalid',
  );
});

test('default inspect reads only the detail', async () => {
  const runtime = fakeRuntime({ 'workflows.getCheckpoint': () => ({ checkpoint }) });
  const run = await runIsagi(['checkpoints', 'inspect', 'wcp_1', '--run', '42', '--json'], {
    runtime,
  });
  assert.equal(run.code, 0);
  assert.deepEqual(onlyJsonDocument(run.stdout), { checkpoint });
  assert.equal(runtime.calls.length, 1);
});

test('--resolved adds every inventory page in server order', async () => {
  const runtime = fakeRuntime({
    'workflows.getCheckpoint': () => ({ checkpoint }),
    'workflows.listCheckpointInventory': pagedRoute({
      first: { checkpointId: 'wcp_1', entries: [{ kind: 'file', path: 'a' }], nextCursor: 'n1' },
      n1: { checkpointId: 'wcp_1', entries: [{ kind: 'absent', path: 'b' }], nextCursor: null },
    }) as never,
  });
  const run = await runIsagi(
    ['checkpoints', 'inspect', 'wcp_1', '--run', '42', '--resolved', '--json'],
    {
      runtime,
    },
  );
  assert.equal(run.code, 0, run.stdout);
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    checkpoint,
    inventory: [
      { kind: 'file', path: 'a' },
      { kind: 'absent', path: 'b' },
    ],
  });
  assert.deepEqual(
    runtime.calls.map((call) => call.endpointId),
    [
      'workflows.getCheckpoint',
      'workflows.listCheckpointInventory',
      'workflows.listCheckpointInventory',
    ],
  );
});

test('--manifest adds every manifest page', async () => {
  const runtime = fakeRuntime({
    'workflows.getCheckpoint': () => ({ checkpoint }),
    'workflows.listCheckpointManifest': pagedRoute({
      first: { checkpointId: 'wcp_1', entries: [{ layer: 1 }], nextCursor: null },
    }) as never,
  });
  const run = await runIsagi(
    ['checkpoints', 'inspect', 'wcp_1', '--run', '42', '--manifest', '--json'],
    {
      runtime,
    },
  );
  assert.deepEqual(onlyJsonDocument(run.stdout), { checkpoint, manifest: [{ layer: 1 }] });
});

test('a page that names another checkpoint is refused', async () => {
  for (const [flag, endpointId] of [
    ['--resolved', 'workflows.listCheckpointInventory'],
    ['--manifest', 'workflows.listCheckpointManifest'],
  ] as const) {
    const runtime = fakeRuntime({
      'workflows.getCheckpoint': () => ({ checkpoint }),
      [endpointId]: () => ({ checkpointId: 'wcp_other', entries: [], nextCursor: null }),
    });
    const run = await runIsagi(['checkpoints', 'inspect', 'wcp_1', '--run', '42', flag, '--json'], {
      runtime,
    });
    assert.equal(run.code, 1);
    const document = onlyJsonDocument(run.stdout) as { error: { code: string } };
    assert.equal(document.error.code, 'runtime_response_invalid');
  }
});
