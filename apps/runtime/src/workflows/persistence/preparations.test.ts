import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  WorkflowPlacementRequestDto,
  WorkflowSetupReceipt,
  WorkflowSurfaceReceipt,
  WorkflowWorktreeReceipt,
} from '@isagi/contracts';

import type { workflowRunPreparations } from '../../persistence/schema.js';
import {
  CorruptRunPreparationError,
  encodePlacementRequest,
  encodeSetupReceipt,
  encodeSurfaceReceipt,
  encodeWorktreeReceipt,
  preparationRecord,
} from './preparations.js';

type PreparationRow = typeof workflowRunPreparations.$inferSelect;

const request: WorkflowPlacementRequestDto = {
  worktree: { kind: 'create', branch: 'feat/placement', fromRef: 'main' },
  surface: { kind: 'create', title: 'Placement' },
};

const worktreeReceipt: WorkflowWorktreeReceipt = {
  acquisition: 'created',
  worktreeId: 7,
  worktreePath: '/data/worktrees/feat-placement',
  branch: 'feat/placement',
  recordedAt: '2026-09-16T10:00:00.000Z',
};

const setupReceipt: WorkflowSetupReceipt = {
  status: 'succeeded',
  reason: null,
  setupRunId: 12,
  failure: null,
  recordedAt: '2026-09-16T10:00:05.000Z',
};

const surfaceReceipt: WorkflowSurfaceReceipt = {
  surfaceId: 31,
  requestedTitle: 'Placement',
  title: 'Placement (2)',
  recordedAt: '2026-09-16T10:00:07.000Z',
};

function row(overrides: Partial<PreparationRow> = {}): PreparationRow {
  return {
    id: 1,
    runId: 42,
    source: 'selector',
    requestJson: encodePlacementRequest(request),
    baseCommit: 'a'.repeat(40),
    checkoutPath: '/data/worktrees/feat-placement',
    worktreeReceiptJson: null,
    setupReceiptJson: null,
    surfaceReceiptJson: null,
    createdAt: '2026-09-16T09:59:00.000Z',
    updatedAt: '2026-09-16T10:00:07.000Z',
    ...overrides,
  };
}

test('a fully receipted preparation row round-trips through the contract schemas', () => {
  const record = preparationRecord(
    row({
      worktreeReceiptJson: encodeWorktreeReceipt(worktreeReceipt),
      setupReceiptJson: encodeSetupReceipt(setupReceipt),
      surfaceReceiptJson: encodeSurfaceReceipt(surfaceReceipt),
    }),
  );

  assert.deepEqual(record, {
    runId: 42,
    source: 'selector',
    request,
    baseCommit: 'a'.repeat(40),
    checkoutPath: '/data/worktrees/feat-placement',
    worktree: worktreeReceipt,
    setup: setupReceipt,
    surface: surfaceReceipt,
    createdAt: '2026-09-16T09:59:00.000Z',
    updatedAt: '2026-09-16T10:00:07.000Z',
  });
});

/**
 * A reuse choice allocates nothing, so it must decode to a null receipt rather than to an empty
 * one. The distinction is what a later attempt reads to tell "reuse what exists" apart from "create
 * it now"; an empty receipt would look like an allocation nobody made.
 */
test('null receipt columns stay null rather than becoming empty receipts', () => {
  const record = preparationRecord(
    row({
      source: 'default',
      requestJson: encodePlacementRequest({
        worktree: { kind: 'current' },
        surface: { kind: 'current' },
      }),
      baseCommit: null,
      checkoutPath: null,
    }),
  );

  assert.equal(record.worktree, null);
  assert.equal(record.setup, null);
  assert.equal(record.surface, null);
  assert.equal(record.baseCommit, null);
  assert.equal(record.checkoutPath, null);
  assert.deepEqual(record.request, {
    worktree: { kind: 'current' },
    surface: { kind: 'current' },
  });
});

test('every worktree and surface choice combination round-trips', () => {
  const worktrees = [
    { kind: 'current' },
    { kind: 'existing', worktreeId: 3 },
    { kind: 'create', branch: 'feat/x', fromRef: 'origin/main' },
  ] as const;
  const surfaces = [
    { kind: 'current' },
    { kind: 'existing', surfaceId: 9 },
    { kind: 'create', title: 'Run' },
  ] as const;

  for (const worktree of worktrees) {
    for (const surface of surfaces) {
      const decoded = preparationRecord(
        row({ requestJson: encodePlacementRequest({ worktree, surface }) }),
      );
      assert.deepEqual(decoded.request, { worktree, surface });
    }
  }
});

/**
 * Every column decoded here was written by this runtime through the same schema, so a failure is a
 * defect rather than an operational condition. It must fail loudly: a guessed placement request
 * would silently relocate a run, and a guessed receipt would make a retry create a second worktree.
 */
test('a corrupt request_json throws CorruptRunPreparationError naming the run and column', () => {
  assert.throws(
    () => preparationRecord(row({ requestJson: '{"worktree":{"kind":"elsewhere"}}' })),
    (error: unknown) => {
      assert.ok(error instanceof CorruptRunPreparationError);
      assert.equal(error._tag, 'CorruptRunPreparationError');
      assert.equal(error.runId, 42);
      assert.equal(error.column, 'request');
      return true;
    },
  );
});

test('request_json that is not JSON at all is reported as such, not as a schema failure', () => {
  assert.throws(
    () => preparationRecord(row({ requestJson: 'not json' })),
    (error: unknown) => {
      assert.ok(error instanceof CorruptRunPreparationError);
      assert.match(error.message, /not valid JSON/);
      return true;
    },
  );
});

test('each corrupt receipt column is named separately', () => {
  const cases = [
    { column: 'worktree receipt', overrides: { worktreeReceiptJson: '{"acquisition":"stolen"}' } },
    { column: 'setup receipt', overrides: { setupReceiptJson: '{"status":"maybe"}' } },
    { column: 'surface receipt', overrides: { surfaceReceiptJson: '{"surfaceId":0}' } },
  ] as const;

  for (const { column, overrides } of cases) {
    assert.throws(
      () => preparationRecord(row(overrides)),
      (error: unknown) => {
        assert.ok(error instanceof CorruptRunPreparationError);
        assert.equal(error.column, column);
        return true;
      },
      `Expected a corrupt ${column} to be reported under its own column name.`,
    );
  }
});
