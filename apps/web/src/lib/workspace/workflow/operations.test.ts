import assert from 'node:assert/strict';
import test from 'node:test';

import type { ListWorkflowOperationsOutput, WorkflowOperationDto } from '@isagi/contracts';

import { emptyRunState, mergeMissingOperations, type WorkflowRunState } from './model.js';
import { hydrateExecutionOperations, WorkflowOperationsStaleError } from './operations.js';
import { workflowOperationFixture } from './test-support.js';

/**
 * The hydration protocol, which exists because the run listing carries no operation rows.
 *
 * Its whole job is to fill history's gaps without ever contradicting the revision-ordered facts the
 * coordinator owns, and each rule below is one way that could go wrong.
 */

function baseState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return { ...emptyRunState(1), hydrated: true, hydrationEpoch: 3, ...overrides };
}

function page(
  items: readonly WorkflowOperationDto[],
  nextCursor: string | null = null,
): ListWorkflowOperationsOutput {
  return { items, nextCursor };
}

function harness(state: WorkflowRunState) {
  let current = state;
  return {
    get state() {
      return current;
    },
    readState: () => current,
    writeState: (update: (value: WorkflowRunState) => WorkflowRunState) => {
      current = update(current);
    },
  };
}

test('every page is read before anything is written', async () => {
  const harnessed = harness(baseState());
  const writes: number[] = [];
  const observed = harnessed.writeState;

  const result = await hydrateExecutionOperations({
    runId: 1,
    executionId: 7,
    hydrationEpoch: 3,
    pageSize: 2,
    read: ({ cursor }) =>
      Promise.resolve(
        cursor === null
          ? page(
              [
                workflowOperationFixture({ operationKey: 'a', executionId: 7 }),
                workflowOperationFixture({ operationKey: 'b', executionId: 7 }),
              ],
              'cursor-1',
            )
          : page([workflowOperationFixture({ operationKey: 'c', executionId: 7 })]),
      ),
    readState: harnessed.readState,
    writeState: (update) => {
      writes.push(1);
      observed(update);
    },
  });

  assert.equal(result.pageCount, 2);
  assert.deepEqual([...result.operationKeys], ['a', 'b', 'c']);
  assert.equal(writes.length, 1, 'one atomic write, after the last page landed');
  assert.deepEqual([...harnessed.state.operations.keys()], ['a', 'b', 'c']);
});

test('a page that fails leaves the projection untouched and claims nothing', async () => {
  const harnessed = harness(baseState());

  await assert.rejects(
    hydrateExecutionOperations({
      runId: 1,
      executionId: 7,
      hydrationEpoch: 3,
      read: ({ cursor }) =>
        cursor === null
          ? Promise.resolve(page([workflowOperationFixture({ operationKey: 'a' })], 'cursor-1'))
          : Promise.reject(new Error('the second page failed')),
      readState: harnessed.readState,
      writeState: harnessed.writeState,
    }),
    /second page failed/,
  );

  assert.equal(
    harnessed.state.operations.size,
    0,
    'a half-read list must never look like a complete one',
  );
});

test('a fetched row can never overwrite one the coordinator already applied', async () => {
  // The delta arrived first and settled the operation; the point-in-time read still says dispatched.
  const settled = workflowOperationFixture({
    operationKey: 'a',
    executionId: 7,
    state: 'completed',
    settledAt: '2026-09-15T10:00:05.000Z',
  });
  const harnessed = harness(baseState({ operations: new Map([['a', settled]]) }));

  await hydrateExecutionOperations({
    runId: 1,
    executionId: 7,
    hydrationEpoch: 3,
    read: () =>
      Promise.resolve(
        page([
          workflowOperationFixture({ operationKey: 'a', executionId: 7, state: 'dispatched' }),
          workflowOperationFixture({ operationKey: 'b', executionId: 7, state: 'completed' }),
        ]),
      ),
    readState: harnessed.readState,
    writeState: harnessed.writeState,
  });

  assert.equal(harnessed.state.operations.get('a')?.state, 'completed', 'coverage wins');
  assert.equal(
    harnessed.state.operations.get('a'),
    settled,
    'the settled row is not even replaced',
  );
  assert.equal(harnessed.state.operations.get('b')?.state, 'completed', 'the gap is still filled');
});

test('a baseline replaced mid-read refuses to commit into the projection that replaced it', async () => {
  const harnessed = harness(baseState({ hydrationEpoch: 3 }));

  await assert.rejects(
    hydrateExecutionOperations({
      runId: 1,
      executionId: 7,
      hydrationEpoch: 3,
      read: () => {
        // A reconnect replaced the baseline while the read was in flight.
        harnessed.writeState((state) => ({ ...state, hydrationEpoch: 4 }));
        return Promise.resolve(page([workflowOperationFixture({ operationKey: 'a' })]));
      },
      readState: harnessed.readState,
      writeState: harnessed.writeState,
    }),
    WorkflowOperationsStaleError,
  );

  assert.equal(harnessed.state.operations.size, 0);
});

test('an aborted read stops paging and never commits', async () => {
  const harnessed = harness(baseState());
  const controller = new AbortController();

  await assert.rejects(
    hydrateExecutionOperations({
      runId: 1,
      executionId: 7,
      hydrationEpoch: 3,
      read: () => {
        controller.abort();
        return Promise.resolve(page([workflowOperationFixture({ operationKey: 'a' })], 'cursor-1'));
      },
      readState: harnessed.readState,
      writeState: harnessed.writeState,
      signal: controller.signal,
    }),
  );

  assert.equal(harnessed.state.operations.size, 0);
});

test('merging is additive by key and leaves the map alone when it has nothing to add', () => {
  const existing = workflowOperationFixture({ operationKey: 'a', state: 'completed' });
  const state = baseState({ operations: new Map([['a', existing]]) });
  assert.equal(
    mergeMissingOperations(state, [workflowOperationFixture({ operationKey: 'a' })]),
    state,
    'no new keys means no new state, so nothing downstream re-renders',
  );
});
