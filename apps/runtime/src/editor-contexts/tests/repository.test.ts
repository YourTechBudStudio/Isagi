import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Cause, Effect, Exit, Layer } from 'effect';

import { DatabaseError } from '../../persistence/index.js';
import { EditorContextRepository, EditorContextTransitionRejected } from '../index.js';
import { EditorContextRowInvariantViolation } from '../row-mapper.js';
import {
  deleteWorktree,
  forceEditorContextColumns,
  insertPtyProcess,
  insertWorktree,
  testLayer,
} from './test-support.js';

type TestServices = Layer.Layer.Success<ReturnType<typeof testLayer>>;

function inDatabase<A, E>(effect: Effect.Effect<A, E, TestServices>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-editor-contexts-'));
  return Effect.runPromise(effect.pipe(Effect.provide(testLayer(dataRoot)))).finally(() =>
    rmSync(dataRoot, { recursive: true, force: true }),
  );
}

function exitInDatabase<A, E>(effect: Effect.Effect<A, E, TestServices>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-editor-contexts-'));
  return Effect.runPromiseExit(effect.pipe(Effect.provide(testLayer(dataRoot)))).finally(() =>
    rmSync(dataRoot, { recursive: true, force: true }),
  );
}

const HANDOFF = {
  ptyProcessId: 0,
  endpointHost: '127.0.0.1',
  endpointPort: 41_234,
  sessionSocketPath: '/tmp/isagi/editors/code-server/sock/1-abc123.sock',
};

test('a created context is idle: no pointer, no endpoint, no attempt', async () => {
  const { created, found } = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const context = yield* repository.create({ worktreeId });
      return { created: context, found: yield* repository.findByWorktree(worktreeId) };
    }),
  );

  assert.deepEqual(created.attempt, { state: 'none' });
  assert.equal(created.activePtyProcessId, null);
  assert.equal(created.endpointHost, null);
  assert.equal(created.endpointPort, null);
  assert.equal(created.sessionSocketPath, null);
  assert.equal(created.activePtyProcess, null);
  assert.deepEqual(found, created);
});

test('one worktree can hold only one editor context', async () => {
  const exit = await exitInDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      yield* repository.create({ worktreeId });
      // The per-worktree lock serializes find-and-place; this is the structural
      // backstop, and reaching it means the lock was bypassed.
      return yield* repository.create({ worktreeId });
    }),
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    assert.equal(failure._tag, 'Some');
    assert.ok(failure.value instanceof DatabaseError);
  }
});

test('deleting a worktree deletes its editor context', async () => {
  const remaining = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });
      yield* deleteWorktree(worktreeId);
      return yield* repository.find(created.id);
    }),
  );

  assert.equal(remaining, null);
});

test('listForIds answers an empty request without a query and joins the rest', async () => {
  const { empty, some, missing } = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const first = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/one'),
      });
      const second = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/two'),
      });
      return {
        empty: yield* repository.listForIds([]),
        some: yield* repository.listForIds([first.id, second.id]),
        missing: yield* repository.listForIds([first.id, 9_999]),
      };
    }),
  );

  assert.deepEqual(empty, []);
  assert.equal(some.length, 2);
  assert.equal(missing.length, 1);
});

test('marking an attempt in progress records a started-at and no reason', async () => {
  const row = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const context = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/isagi'),
      });
      yield* repository.markAttemptInProgress(context.id);
      return yield* repository.find(context.id);
    }),
  );

  assert.equal(row?.attempt.state, 'in_progress');
  assert.equal(row?.activePtyProcessId, null);
  if (row?.attempt.state === 'in_progress') assert.ok(row.attempt.startedAt.length > 0);
});

test('the handoff installs pointer, endpoint, and socket and closes the attempt', async () => {
  const row = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const context = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/isagi'),
      });
      const ptyProcessId = yield* insertPtyProcess('running');
      yield* repository.markAttemptInProgress(context.id);
      yield* repository.installIncarnation({
        editorContextId: context.id,
        handoff: { ...HANDOFF, ptyProcessId },
      });
      return yield* repository.find(context.id);
    }),
  );

  assert.deepEqual(row?.attempt, { state: 'none' });
  assert.equal(row?.endpointHost, '127.0.0.1');
  assert.equal(row?.endpointPort, 41_234);
  assert.equal(row?.sessionSocketPath, HANDOFF.sessionSocketPath);
  assert.equal(row?.activePtyProcess?.status, 'running');
  assert.equal(row?.activePtyProcessId, row?.activePtyProcess?.id);
});

test('an installed incarnation is findable by the process it points at', async () => {
  const { found, unrelated } = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const context = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/isagi'),
      });
      const ptyProcessId = yield* insertPtyProcess('running');
      const otherProcessId = yield* insertPtyProcess('running');
      yield* repository.markAttemptInProgress(context.id);
      yield* repository.installIncarnation({
        editorContextId: context.id,
        handoff: { ...HANDOFF, ptyProcessId },
      });
      return {
        found: yield* repository.findByActivePtyProcessId(ptyProcessId),
        unrelated: yield* repository.findByActivePtyProcessId(otherProcessId),
      };
    }),
  );

  assert.equal(found?.endpointPort, 41_234);
  assert.equal(unrelated, null);
});

test('a replacement clears ownership and opens the next attempt in one transition', async () => {
  const row = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const context = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/isagi'),
      });
      yield* repository.markAttemptInProgress(context.id);
      yield* repository.installIncarnation({
        editorContextId: context.id,
        handoff: { ...HANDOFF, ptyProcessId: yield* insertPtyProcess('running') },
      });
      yield* repository.clearIncarnationAndMarkInProgress(context.id);
      return yield* repository.find(context.id);
    }),
  );

  // Invariants 1 and 2 together: nothing is retained, and the open attempt has
  // no pointer beside it.
  assert.equal(row?.attempt.state, 'in_progress');
  assert.equal(row?.activePtyProcessId, null);
  assert.equal(row?.endpointHost, null);
  assert.equal(row?.endpointPort, null);
  assert.equal(row?.sessionSocketPath, null);
});

test('a failure without ownership records its reason and clears the started-at', async () => {
  const row = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const context = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/isagi'),
      });
      yield* repository.markAttemptInProgress(context.id);
      yield* repository.markAttemptFailed({
        editorContextId: context.id,
        reason: 'port_allocation_failed',
        detail: 'no loopback port was free',
      });
      return yield* repository.find(context.id);
    }),
  );

  assert.deepEqual(row?.attempt, {
    state: 'failed',
    reason: 'port_allocation_failed',
    detail: 'no loopback port was free',
  });
  assert.equal(row?.activePtyProcessId, null);
});

test('a refused replacement reports a live incarnation and a failed attempt at once', async () => {
  const row = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const context = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/isagi'),
      });
      const ptyProcessId = yield* insertPtyProcess('running');
      yield* repository.markAttemptInProgress(context.id);
      yield* repository.installIncarnation({
        editorContextId: context.id,
        handoff: { ...HANDOFF, ptyProcessId },
      });
      // Ownership is never dropped on a predecessor that was not affirmatively
      // stopped, so the pointer must survive the failure.
      yield* repository.markAttemptFailed({
        editorContextId: context.id,
        reason: 'previous_incarnation_not_stopped',
        detail: 'kill timed out',
      });
      return yield* repository.find(context.id);
    }),
  );

  assert.equal(row?.attempt.state, 'failed');
  assert.equal(row?.activePtyProcessId !== null, true);
  assert.equal(row?.endpointPort, 41_234);
  assert.equal(row?.activePtyProcess?.status, 'running');
});

test('clearing an incarnation returns the context to idle', async () => {
  const row = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const context = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/isagi'),
      });
      yield* repository.markAttemptInProgress(context.id);
      yield* repository.installIncarnation({
        editorContextId: context.id,
        handoff: { ...HANDOFF, ptyProcessId: yield* insertPtyProcess('running') },
      });
      yield* repository.markAttemptFailed({
        editorContextId: context.id,
        reason: 'previous_incarnation_not_stopped',
        detail: null,
      });
      yield* repository.clearIncarnation(context.id);
      return yield* repository.find(context.id);
    }),
  );

  assert.deepEqual(row?.attempt, { state: 'none' });
  assert.equal(row?.activePtyProcessId, null);
  assert.equal(row?.sessionSocketPath, null);
});

test('boot converts every interrupted attempt and leaves the other states alone', async () => {
  const { affected, interrupted, idle, alreadyFailed, live } = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const stuckContext = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/one'),
      });
      const idleContext = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/two'),
      });
      const failedContext = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/three'),
      });
      const liveContext = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/four'),
      });

      yield* repository.markAttemptInProgress(stuckContext.id);
      yield* repository.markAttemptFailed({
        editorContextId: failedContext.id,
        reason: 'launch_target_missing',
        detail: 'code-server is gone',
      });
      yield* repository.markAttemptInProgress(liveContext.id);
      yield* repository.installIncarnation({
        editorContextId: liveContext.id,
        handoff: { ...HANDOFF, ptyProcessId: yield* insertPtyProcess('running') },
      });

      return {
        affected: yield* repository.failInterruptedAttempts,
        interrupted: yield* repository.find(stuckContext.id),
        idle: yield* repository.find(idleContext.id),
        alreadyFailed: yield* repository.find(failedContext.id),
        live: yield* repository.find(liveContext.id),
      };
    }),
  );

  assert.deepEqual(affected, [interrupted!.id]);
  assert.deepEqual(interrupted?.attempt, {
    state: 'failed',
    reason: 'launch_interrupted',
    detail: null,
  });
  assert.deepEqual(idle?.attempt, { state: 'none' });
  assert.equal(
    alreadyFailed?.attempt.state === 'failed' ? alreadyFailed.attempt.reason : null,
    'launch_target_missing',
  );
  assert.deepEqual(live?.attempt, { state: 'none' });
  assert.equal(live?.activePtyProcessId !== null, true);
});

/**
 * The guards below are the write-side half of the invariants. The row mapper
 * proves an impossible row is caught on read; these prove it cannot be written,
 * which is the stronger claim the repository's contract actually makes.
 */
function assertRejectedTransition(exit: Exit.Exit<unknown, unknown>, precondition: string) {
  assert.equal(Exit.isFailure(exit), true);
  if (!Exit.isFailure(exit)) return;
  const defect = Cause.dieOption(exit.cause);
  assert.equal(defect._tag, 'Some');
  assert.ok(defect.value instanceof EditorContextTransitionRejected);
  assert.equal(defect.value.precondition, precondition);
}

test('an attempt cannot be opened on a context that still owns an incarnation', async () => {
  const { exit, row } = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const context = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/isagi'),
      });
      yield* repository.markAttemptInProgress(context.id);
      yield* repository.installIncarnation({
        editorContextId: context.id,
        handoff: { ...HANDOFF, ptyProcessId: yield* insertPtyProcess('running') },
      });
      // Transition 2 exists precisely so this sequence is never needed.
      const refusal = yield* Effect.exit(repository.markAttemptInProgress(context.id));
      return { exit: refusal, row: yield* repository.find(context.id) };
    }),
  );

  assertRejectedTransition(exit, 'the context holds no incarnation');
  // The refused write left nothing behind: still owned, still idle.
  assert.deepEqual(row?.attempt, { state: 'none' });
  assert.equal(row?.activePtyProcessId !== null, true);
});

test('a failure that is not a refused replacement cannot be recorded beside a pointer', async () => {
  const { exit, row } = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const context = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/isagi'),
      });
      yield* repository.markAttemptInProgress(context.id);
      yield* repository.installIncarnation({
        editorContextId: context.id,
        handoff: { ...HANDOFF, ptyProcessId: yield* insertPtyProcess('running') },
      });
      const refusal = yield* Effect.exit(
        repository.markAttemptFailed({
          editorContextId: context.id,
          reason: 'port_allocation_failed',
          detail: 'no loopback port was free',
        }),
      );
      return { exit: refusal, row: yield* repository.find(context.id) };
    }),
  );

  assertRejectedTransition(exit, 'the context holds no incarnation');
  assert.deepEqual(row?.attempt, { state: 'none' });
});

test('an incarnation cannot be installed over an incarnation or without an open attempt', async () => {
  const { withoutAttempt, overOwnership } = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const context = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/isagi'),
      });
      const beforeAttempt = yield* Effect.exit(
        repository.installIncarnation({
          editorContextId: context.id,
          handoff: { ...HANDOFF, ptyProcessId: yield* insertPtyProcess('running') },
        }),
      );
      yield* repository.markAttemptInProgress(context.id);
      yield* repository.installIncarnation({
        editorContextId: context.id,
        handoff: { ...HANDOFF, ptyProcessId: yield* insertPtyProcess('running') },
      });
      const afterOwnership = yield* Effect.exit(
        repository.installIncarnation({
          editorContextId: context.id,
          handoff: { ...HANDOFF, ptyProcessId: yield* insertPtyProcess('running') },
        }),
      );
      return { withoutAttempt: beforeAttempt, overOwnership: afterOwnership };
    }),
  );

  const precondition = 'the context holds no incarnation and has an attempt in progress';
  assertRejectedTransition(withoutAttempt, precondition);
  assertRejectedTransition(overOwnership, precondition);
});

test('a transition against a deleted context reports it instead of reporting success', async () => {
  const outcomes = await inDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const context = yield* repository.create({ worktreeId });
      const ptyProcessId = yield* insertPtyProcess('running');
      // A worktree deletion cascades the context away; a launch already in
      // flight can still reach the repository afterwards.
      yield* deleteWorktree(worktreeId);
      return {
        open: yield* repository.markAttemptInProgress(context.id),
        install: yield* repository.installIncarnation({
          editorContextId: context.id,
          handoff: { ...HANDOFF, ptyProcessId },
        }),
        failed: yield* repository.markAttemptFailed({
          editorContextId: context.id,
          reason: 'launch_allocation_failed',
          detail: null,
        }),
        replace: yield* repository.clearIncarnationAndMarkInProgress(context.id),
        clear: yield* repository.clearIncarnation(context.id),
      };
    }),
  );

  assert.deepEqual(outcomes, {
    open: 'context_missing',
    install: 'context_missing',
    failed: 'context_missing',
    replace: 'context_missing',
    clear: 'context_missing',
  });
});

test('an impossible persisted row fails as a defect, not as a database error', async () => {
  const exit = await exitInDatabase(
    Effect.gen(function* () {
      const repository = yield* EditorContextRepository;
      const context = yield* repository.create({
        worktreeId: yield* insertWorktree('/repo/isagi'),
      });
      // A shape no transition in this repository can write.
      yield* forceEditorContextColumns(context.id, {
        attemptState: 'in_progress',
        attemptStartedAt: new Date().toISOString(),
        activePtyProcessId: yield* insertPtyProcess('running'),
        endpointHost: '127.0.0.1',
        endpointPort: 41_234,
        sessionSocketPath: '/tmp/a.sock',
      });
      return yield* repository.find(context.id);
    }),
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    // The distinction that matters: had the mapper run inside
    // `RuntimeDatabase.use`, this would arrive as a typed `DatabaseError` and be
    // reported to the user as an ordinary database fault.
    assert.equal(Cause.failureOption(exit.cause)._tag, 'None');
    const defect = Cause.dieOption(exit.cause);
    assert.equal(defect._tag, 'Some');
    if (defect._tag === 'Some') {
      assert.ok(defect.value instanceof EditorContextRowInvariantViolation);
      assert.match(defect.value.message, /in_progress beside a pointer/);
    }
  }
});
