import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after as afterAll } from 'node:test';

import type { EngineHarness } from '../../engine/test-support.js';
import { contentPathFor, run } from '../../persistence/test-support.js';
import {
  drivePipeline,
  evidenceRows,
  evidenceShape as shape,
  evidenceText as contentOf,
  captureOperations,
  listAllEvidence as listAll,
  operationHistory,
  projectionOf,
  rootFrameId,
  withHarness,
  type JudgmentContext,
} from '../drive.js';
import { publishPhaseWiseReview } from './drive.js';

/**
 * `phase-wise-review`, end to end: what a run keeps, and what survives failing halfway through it.
 *
 * Every assertion here is about a **durable record or the read model** — never about how many times
 * something was called. That is deliberate: the story's claims are claims about what a person can
 * still retrieve weeks later, and a call-count assertion would go green on an implementation that
 * captured nothing.
 */

// --- world ------------------------------------------------------------------------------------

const PLAN = '# The plan\n\nThree phases, reviewed.\n';
const DECISIONS = '# Decisions\n\nNothing yet.\n';

/** The worktree the run will actually resolve `file` captures against. */
function seedWorktree(harness: EngineHarness, files: Record<string, string> = {}) {
  const root = harness.fixture.worktreeDirectory;
  const all = { 'docs/plan.md': PLAN, 'docs/decisions.md': DECISIONS, ...files };
  for (const [relative, contents] of Object.entries(all)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
  }
  return root;
}

/**
 * A Claude headless body, shaped the way the installed CLI prints one.
 *
 * Fed through the real extractor by the driver, so what this exercises is the extractor phase 02
 * confirmed against the CLI — including the two cache fields, which exist precisely because bare
 * `input_tokens` reads near-zero on any cached workload.
 */
function claudeBody(sessionId: string, text: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: text,
    total_cost_usd: 0.42,
    usage: {
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 5678,
      cache_creation_input_tokens: 90,
    },
  });
}

const COMMIT_REPORT = JSON.stringify({
  outcome: 'committed',
  commit: 'c0ffee1234567890',
  subject: 'feat: the phase',
});

/** Answers every headless judgment by the node that asked it. Never approves, so rounds run out. */
function verdicts(approveAfter = Number.POSITIVE_INFINITY) {
  let approvals = 0;
  return (_round: number, { execution }: JudgmentContext): string => {
    switch (execution.nodeId) {
      case 'assess':
        return 'ready';
      case 'commit':
        return COMMIT_REPORT;
      case 'judgeFeedback':
        approvals += 1;
        return approvals >= approveAfter ? 'approve' : 'needs work';
      default:
        return 'ready';
    }
  };
}

async function launchPhaseWise(
  harness: EngineHarness,
  inputs: Record<string, unknown> = {},
): Promise<number> {
  const launched = await harness.launch({
    workflowKey: 'phase-wise-review',
    inputs: { planPath: 'docs/plan.md', decisionLogPath: 'docs/decisions.md', ...inputs },
  });
  return launched.id;
}

// --- the happy run ------------------------------------------------------------------------------

test('a phase-wise run keeps the plan, every round, the verification and the commit', async () => {
  await withHarness(async (harness) => {
    seedWorktree(harness);
    publishPhaseWiseReview(harness);
    harness.adapters.conversationHistory = [
      { role: 'assistant', parts: [{ type: 'text', text: 'I did the work.', state: 'done' }] },
    ];
    const runId = await launchPhaseWise(harness, { phases: 1, reviewLimit: 3 });

    const finished = await drivePipeline(harness, runId, verdicts(), { maxPasses: 120 });
    assert.equal(finished.status, 'done', 'the run reached its own success outcome');
    assert.equal(finished.outcomeId, 'delivered');

    const items = await listAll(harness, runId);

    // Criterion 4: the evidence tree the story sketches, asserted as a `(role, labels)` multiset.
    // Three review rounds, each with a reviewer and a fixer, under one phase.
    assert.deepEqual(shape(items), [
      'commit{"phase":1}',
      'decision-log{}',
      'fixer-response{"phase":1,"round":1}',
      'fixer-response{"phase":1,"round":2}',
      'fixer-response{"phase":1,"round":3}',
      'implementer-response{"phase":1}',
      'plan{}',
      'review-feedback{"phase":1,"round":1}',
      'review-feedback{"phase":1,"round":2}',
      'review-feedback{"phase":1,"round":3}',
      'verification{"phase":1}',
    ]);

    // Criterion 1, at a placement the unit suite structurally cannot reach: a capture made three
    // frames deep reports its whole position, its pin, its time and its resolved source.
    const deep = items.find((item) => item.role === 'review-feedback' && item.labels.round === 2)!;
    assert.match(deep.evidenceKey, /^wev_[0-9a-f-]{36}$/);
    const frames = await run(harness.fixture.runs.listFrames(runId));
    const roundFrame = frames.find((frame) => frame.id === deep.frameId)!;
    assert.equal(roundFrame.graphKey, 'review-round');
    assert.equal(roundFrame.depth, 2, 'three layers of graph, and this row is at the bottom one');

    const row = evidenceRows(harness).find(
      (candidate) => candidate.evidence_key === deep.evidenceKey,
    )!;
    assert.equal(row.run_id, runId);
    assert.equal(row.frame_id, deep.frameId);
    assert.equal(row.execution_id, deep.executionId);
    assert.equal(row.attempt_id, deep.attemptId);
    assert.equal(row.artifact_hash, finished.artifactHash);
    assert.equal(deep.artifactHash, finished.artifactHash, 'the pin is copied from the operation');
    assert.ok(row.captured_at.length > 0);
    assert.ok(row.operation_id > 0);

    // The source the author handed back — the spawn handle, with its `paneId` projected away.
    assert.equal(deep.source.kind, 'agent_turn');
    assert.equal(deep.source.attribution, 'exact');
    assert.ok((deep.source.agentSessionId ?? 0) > 0);
    assert.ok(deep.source.operationKey, 'an exact source names the operation that produced it');

    // Four content kinds are covered as a by-product of the tree above.
    assert.deepEqual([...new Set(items.map((item) => item.content.kind))].sort(), [
      'file',
      'json',
      'text',
    ]);
    const plan = items.find((item) => item.role === 'plan')!;
    assert.equal(plan.content.kind, 'file');
    assert.equal(plan.content.sourcePath, 'docs/plan.md');
    assert.equal(await contentOf(harness, runId, plan.evidenceKey), PLAN);

    // The verification is a recorded literal, and reads back as one.
    const verification = items.find((item) => item.role === 'verification')!;
    assert.deepEqual(JSON.parse(await contentOf(harness, runId, verification.evidenceKey)), {
      command: 'pnpm check',
      exitCode: 0,
    });

    // The commit is a parsed fact attributed exactly to the headless operation that produced it.
    const commit = items.find((item) => item.role === 'commit')!;
    assert.deepEqual(JSON.parse(await contentOf(harness, runId, commit.evidenceKey)), {
      commit: 'c0ffee1234567890',
      subject: 'feat: the phase',
    });
    assert.equal(commit.source.kind, 'headless_operation');
    assert.equal(commit.source.attribution, 'exact');
  });
});

// --- criterion 3: rounds are separately retrievable, and state holds no content -------------------

test('three review rounds are separately retrievable, and no graph state array holds content', async () => {
  await withHarness(async (harness) => {
    seedWorktree(harness);
    publishPhaseWiseReview(harness);
    harness.adapters.conversationHistory = [
      { role: 'assistant', parts: [{ type: 'text', text: 'round text', state: 'done' }] },
    ];
    const runId = await launchPhaseWise(harness, { phases: 1, reviewLimit: 3 });
    await drivePipeline(harness, runId, verdicts(), { maxPasses: 120 });

    const feedback = await listAll(harness, runId, { role: 'review-feedback' });
    assert.equal(feedback.length, 3);
    assert.deepEqual(
      feedback.map((item) => item.labels.round).sort(),
      [1, 2, 3],
      'each round is its own record, distinguished by its label',
    );

    // Filtering by one round returns exactly that round's two captures, across both roles.
    const round2 = await listAll(harness, runId, { label: ['round:2'] });
    assert.deepEqual(shape(round2), [
      'fixer-response{"phase":1,"round":2}',
      'review-feedback{"phase":1,"round":2}',
    ]);

    // Grouped by frame in run scope: three round frames, two captures each.
    const byFrame = new Map<number, number>();
    for (const item of [
      ...feedback,
      ...(await listAll(harness, runId, { role: 'fixer-response' })),
    ]) {
      byFrame.set(item.frameId, (byFrame.get(item.frameId) ?? 0) + 1);
    }
    assert.equal(byFrame.size, 3, 'one frame per round');
    assert.deepEqual([...byFrame.values()], [2, 2, 2]);

    // The hard half. The authored source kept review text in a growing state array; this one keeps
    // references. Asserted against the persisted state payload, not against the declared type — a
    // shape-only check passes on a state that carries the id *and* the text beside it.
    const frames = await run(harness.fixture.runs.listFrames(runId));
    for (const frame of frames) {
      if (!frame.state) continue;
      const state = (await run(harness.fixture.payloads.resolve(frame.state))) as unknown;
      const serialised = JSON.stringify(state);
      assert.ok(
        !serialised.includes('round text'),
        `frame ${frame.graphKey} still holds captured content: ${serialised}`,
      );
      for (const value of Object.values(state as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        for (const entry of value) {
          assert.ok(
            typeof entry === 'string' && entry.startsWith('wev_'),
            `an array in ${frame.graphKey} holds ${JSON.stringify(entry)} rather than a reference`,
          );
        }
      }
    }
  });
});

// --- criterion 5: a callback that fails after capturing is repaired, not re-read -------------------

test('a Retry reuses the captured reference instead of the newer agent response', async () => {
  await withHarness(async (harness) => {
    seedWorktree(harness);
    publishPhaseWiseReview(harness, { throwAfterCapture: 'readImplementer' });

    // What every agent says on the first pass.
    const said = (text: string) => {
      harness.adapters.conversationHistory = [
        { role: 'assistant', parts: [{ type: 'text', text, state: 'done' }] },
      ];
    };
    said('FIRST response');

    const runId = await launchPhaseWise(harness, { phases: 1, reviewLimit: 1 });
    await drivePipeline(harness, runId, verdicts(), { maxPasses: 20 });

    const failed = await harness.runOf(runId);
    assert.equal(failed.status, 'failed', 'the callback threw after its capture committed');
    const afterFirst = evidenceRows(harness).filter((row) => row.role === 'implementer-response');
    assert.equal(afterFirst.length, 1, 'the capture is durable although the segment is not');
    const original = afterFirst[0]!;
    assert.equal(await contentOf(harness, runId, original.evidence_key), 'FIRST response');

    // The world moves on. Every session — including the implementer's, explicitly — now answers
    // with something else, so "the capture was reused" cannot be true by accident.
    const implementerSession = original.source_agent_session_id!;
    assert.ok(implementerSession > 0);
    said('SECOND response, written later');
    harness.conversation.set(implementerSession, 'SECOND response, written later');

    const control = await harness.retry(runId);
    assert.equal(control.accepted, true, JSON.stringify(control));
    const repaired = await drivePipeline(harness, runId, verdicts(), { maxPasses: 120 });
    assert.equal(repaired.status, 'done');

    const afterRetry = evidenceRows(harness).filter((row) => row.role === 'implementer-response');
    assert.equal(afterRetry.length, 1, 'exactly one row at that call position, not two');
    assert.equal(
      afterRetry[0]!.evidence_key,
      original.evidence_key,
      'the same reference came back',
    );
    assert.equal(
      afterRetry[0]!.content_ref,
      original.content_ref,
      'and it still points at the bytes captured on the first pass',
    );
    assert.equal(
      await contentOf(harness, runId, original.evidence_key),
      'FIRST response',
      'the repaired callback got what was captured, not what the agent says now',
    );

    // The non-vacuity half: the repaired run did read the *newer* conversation everywhere it was
    // actually supposed to. Without this the assertion above would pass on a stubbed world that
    // never changed its answer.
    const fixers = evidenceRows(harness).filter((row) => row.role === 'fixer-response');
    assert.equal(fixers.length, 1);
    assert.equal(
      await contentOf(harness, runId, fixers[0]!.evidence_key),
      'SECOND response, written later',
      'a capture made after the repair reads the conversation as it is now',
    );
  });
});

test('a nested capture that fails after committing is reused at its own frame, not re-read', async () => {
  await withHarness(async (harness) => {
    seedWorktree(harness);
    publishPhaseWiseReview(harness, { throwAfterCapture: 'reviewFeedback' });

    const said = (text: string) => {
      harness.adapters.conversationHistory = [
        { role: 'assistant', parts: [{ type: 'text', text, state: 'done' }] },
      ];
    };
    said('FIRST review');

    const runId = await launchPhaseWise(harness, { phases: 1, reviewLimit: 1 });
    await drivePipeline(harness, runId, verdicts(), { maxPasses: 40 });
    assert.equal((await harness.runOf(runId)).status, 'failed');

    const first = evidenceRows(harness).filter((row) => row.role === 'review-feedback');
    assert.equal(first.length, 1);
    const original = first[0]!;

    // The capture that failed is two frames below the root, which is the thing this adds over the
    // `readImplementer` case: the reused position is inside a subgraph invocation.
    const frames = await run(harness.fixture.runs.listFrames(runId));
    assert.equal(frames.find((frame) => frame.id === original.frame_id)!.depth, 2);

    said('SECOND review, written later');
    const control = await harness.retry(runId);
    assert.equal(control.accepted, true, JSON.stringify(control));
    const repaired = await drivePipeline(harness, runId, verdicts(), { maxPasses: 120 });
    assert.equal(repaired.status, 'done');

    const after = evidenceRows(harness).filter((row) => row.role === 'review-feedback');
    assert.equal(after.length, 1, 'the nested call position was reused, not revisited');
    assert.equal(after[0]!.evidence_key, original.evidence_key);
    assert.equal(await contentOf(harness, runId, original.evidence_key), 'FIRST review');
    assert.equal(
      await contentOf(
        harness,
        runId,
        evidenceRows(harness).find((row) => row.role === 'fixer-response')!.evidence_key,
      ),
      'SECOND review, written later',
      'and the repaired pass read the newer conversation where it was meant to',
    );
  });
});

// --- criteria 5 and 9: a publication that fails, diagnosed and then repaired ----------------------

test('a failed content publication leaves an intended row, and Retry reopens the same position', async () => {
  await withHarness(async (harness) => {
    seedWorktree(harness);
    publishPhaseWiseReview(harness);
    const runId = await launchPhaseWise(harness, { phases: 1, reviewLimit: 1 });

    // The very first capture the run makes is the plan file.
    harness.content.failNextPut();
    await drivePipeline(harness, runId, verdicts(1), { maxPasses: 20 });

    const failed = await harness.runOf(runId);
    assert.equal(failed.status, 'failed');
    assert.equal(evidenceRows(harness).length, 0, 'no evidence row for an uncommitted capture');

    const intended = (await run(harness.fixture.operations.listUnsettled({ runId }))).filter(
      (record) => record.capability === 'capture_evidence',
    );
    assert.equal(intended.length, 1);
    assert.equal(intended[0]!.state, 'intended');
    const operationKey = intended[0]!.operationKey;

    // The failure is diagnosable: it names the rejection and the operation it happened at.
    const attempts = await run(
      harness.fixture.runs.listAttemptsForFrame(await rootFrameId(harness, runId)),
    );
    const failedAttempt = attempts.find((attempt) => attempt.status === 'failed')!;
    assert.equal(failedAttempt.failureCode, 'evidence_capture_rejected');
    const detail = JSON.stringify(failedAttempt.failureDetail ?? {});
    assert.match(detail, /content_unavailable/);
    assert.match(detail, new RegExp(operationKey));

    const control = await harness.retry(runId);
    assert.equal(control.accepted, true, JSON.stringify(control));
    const repaired = await drivePipeline(harness, runId, verdicts(1), { maxPasses: 120 });
    assert.equal(repaired.status, 'done');

    const captures = captureOperations(harness, runId).filter(
      (capture) => capture.operation_key === operationKey,
    );
    assert.equal(captures.length, 1, 'the same call position was reopened, not duplicated');
    assert.equal(captures[0]!.state, 'completed');
    const plan = evidenceRows(harness).filter((row) => row.role === 'plan');
    assert.equal(plan.length, 1, 'exactly one evidence row after the repair');

    // The whole `intended -> abandoned -> reopened -> completed` sequence, read from history rather
    // than sampled. `abandoned` is transient inside one drain — reconciliation abandons the row at
    // dispatch, the callback re-enters, and the commit reopens it — so catching it mid-flight would
    // be a timing assumption. The abandonment is durable in its own transition, and asserting there
    // proves the sequence without stepping the dispatcher.
    const history = await operationHistory(harness, operationKey);
    assert.deepEqual(
      history.map((entry) => entry.kind),
      ['operation_recorded', 'operation_settled', 'operation_settled'],
      'the abandonment was not rewritten away when the row was reopened',
    );
    assert.deepEqual(
      history[1]!.detail,
      { reason: 'capture_not_committed' },
      'the first settlement is the abandonment, and it says why',
    );
    assert.deepEqual(
      history[2]!.detail,
      { evidenceKey: plan[0]!.evidence_key },
      'the second names what finally settled the position, not the reason it was abandoned',
    );
  });
});

// --- criteria 5 and 9: a crash between the bytes and the row --------------------------------------

test('a crash committing the capture leaves a named orphan, and Retry dedups onto it', async () => {
  await withHarness(async (harness) => {
    seedWorktree(harness);
    publishPhaseWiseReview(harness);
    const runId = await launchPhaseWise(harness, { phases: 1, reviewLimit: 1 });

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      harness.crashNext('commitCapture');
      await drivePipeline(harness, runId, verdicts(1), { maxPasses: 20 });
    } finally {
      console.warn = originalWarn;
    }

    const failed = await harness.runOf(runId);
    assert.equal(failed.status, 'failed');
    assert.equal(evidenceRows(harness).length, 0, 'the bytes are durable; the row is not');

    // The transaction that would have settled the position is the one that rolled back, so the
    // operation is left unsettled rather than failed — which is what makes the Retry a repair of
    // this position instead of a new call at a new one.
    const unsettled = captureOperations(harness, runId);
    assert.equal(unsettled.length, 1);
    assert.equal(unsettled[0]!.state, 'intended');

    // The orphan is traceable. This is the whole condition under which phase 03 accepted an
    // unswept leak, so it is asserted rather than trusted.
    // Scoped to this run, not merely to "a warning mentioning a digest". Every suite shares one
    // process under `--experimental-test-isolation=none`, so an unrelated warning must not be able
    // to satisfy the assertion that *this* run's orphan was named.
    const warned = warnings.find((args) => {
      const text = JSON.stringify(args);
      return text.includes('sha256:') && text.includes(String(runId));
    });
    assert.ok(warned, `no diagnostic named this run's orphaned blob: ${JSON.stringify(warnings)}`);
    const contentRef = String(
      (warned.find((arg) => typeof arg === 'object' && arg !== null) as Record<string, unknown>)
        .contentRef,
    );
    assert.match(contentRef, /^sha256:[0-9a-f]{64}$/);

    const control = await harness.retry(runId);
    assert.equal(control.accepted, true, JSON.stringify(control));
    const repaired = await drivePipeline(harness, runId, verdicts(1), { maxPasses: 120 });
    assert.equal(repaired.status, 'done');

    // Identical bytes republish onto the blob that was already there: the same digest, one file.
    const plan = evidenceRows(harness).filter((row) => row.role === 'plan');
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.content_ref, contentRef, 'the Retry deduped onto the orphaned blob');
    assert.equal(
      await contentOf(harness, runId, plan[0]!.evidence_key),
      PLAN,
      'and the bytes behind it verify',
    );
  });
});

// --- criterion 10: paths that must be refused, and refused honestly --------------------------------

test('a symlink out of the worktree is refused after intent, and the position re-dispatches', async () => {
  await withHarness(async (harness) => {
    const worktree = seedWorktree(harness);
    // A real escape, built by the test: the link is inside the worktree, its target is not.
    const outside = mkdtempSync(join(tmpdir(), 'isagi-evidence-escape-'));
    afterAll(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'secret.md'), 'not yours', 'utf8');
    symlinkSync(join(outside, 'secret.md'), join(worktree, 'docs', 'escape.md'));

    publishPhaseWiseReview(harness);
    const runId = await launchPhaseWise(harness, {
      planPath: 'docs/escape.md',
      phases: 1,
      reviewLimit: 1,
    });
    await drivePipeline(harness, runId, verdicts(1), { maxPasses: 20 });

    const failed = await harness.runOf(runId);
    assert.equal(failed.status, 'failed');
    assert.equal(evidenceRows(harness).length, 0);

    // Immediately after the failed attempt: the call position was claimed before the filesystem was
    // touched, so the rejection is recorded against a real position rather than nowhere.
    const claimed = (await run(harness.fixture.operations.listUnsettled({ runId }))).filter(
      (record) => record.capability === 'capture_evidence',
    );
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.state, 'intended');
    const operationKey = claimed[0]!.operationKey;

    const attempts = await run(
      harness.fixture.runs.listAttemptsForFrame(await rootFrameId(harness, runId)),
    );
    const failedAttempt = attempts.find((attempt) => attempt.status === 'failed')!;
    assert.equal(failedAttempt.failureCode, 'evidence_capture_rejected');
    assert.match(JSON.stringify(failedAttempt.failureDetail ?? {}), /path_outside_worktree/);

    // On Retry, reconciliation runs at dispatch — not in the control — and abandons the row before
    // the callback is re-entered. `recordIntent` then adopts that abandoned row without changing
    // its state, and this capture never commits because the filesystem was never repaired. So the
    // position's *terminal* state is `abandoned`, and it is refused the same way again.
    const control = await harness.retry(runId);
    assert.equal(control.accepted, true, JSON.stringify(control));
    await drivePipeline(harness, runId, verdicts(1), { maxPasses: 20 });

    const positions = captureOperations(harness, runId);
    assert.deepEqual(
      positions.map((position) => position.operation_key),
      [operationKey],
      'the same call position re-dispatched; no second row at a new position',
    );
    assert.equal(
      positions[0]!.state,
      'abandoned',
      'reconciliation abandoned the position, and nothing reopened it',
    );
    const stillFailed = await harness.runOf(runId);
    assert.equal(stillFailed.status, 'failed');
    const retryAttempts = await run(
      harness.fixture.runs.listAttemptsForFrame(await rootFrameId(harness, runId)),
    );
    const last = retryAttempts.filter((attempt) => attempt.status === 'failed').at(-1)!;
    assert.match(JSON.stringify(last.failureDetail ?? {}), /path_outside_worktree/);
    assert.equal(evidenceRows(harness).length, 0);
  });
});

test('a plan path that does not exist is refused as path_not_found', async () => {
  await withHarness(async (harness) => {
    seedWorktree(harness);
    publishPhaseWiseReview(harness);
    const runId = await launchPhaseWise(harness, {
      planPath: 'docs/absent.md',
      phases: 1,
      reviewLimit: 1,
    });
    await drivePipeline(harness, runId, verdicts(1), { maxPasses: 20 });

    const failed = await harness.runOf(runId);
    assert.equal(failed.status, 'failed');
    const attempts = await run(
      harness.fixture.runs.listAttemptsForFrame(await rootFrameId(harness, runId)),
    );
    const failedAttempt = attempts.find((attempt) => attempt.status === 'failed')!;
    assert.equal(failedAttempt.failureCode, 'evidence_capture_rejected');
    assert.match(JSON.stringify(failedAttempt.failureDetail ?? {}), /path_not_found/);
    assert.equal(evidenceRows(harness).length, 0);
  });
});

// --- criterion 6: provenance on the operations behind the captures ---------------------------------

test('the operations behind a run report harness, cwd, runtime identity, session and usage', async () => {
  await withHarness(async (harness) => {
    seedWorktree(harness);
    publishPhaseWiseReview(harness);
    harness.adapters.conversationHistory = [
      { role: 'assistant', parts: [{ type: 'text', text: 'done', state: 'done' }] },
    ];
    const runId = await launchPhaseWise(harness, { phases: 1, reviewLimit: 1 });
    await drivePipeline(harness, runId, verdicts(1), {
      maxPasses: 120,
      raw: ({ execution }) => claudeBody(`claude-session-${execution.nodeId}`, 'ok'),
    });
    assert.equal((await harness.runOf(runId)).status, 'done');

    const projection = projectionOf(harness);
    const items = await listAll(harness, runId);

    // The send behind a captured response: everything the runtime knew at dispatch, and no usage,
    // because an interactive turn's cost is not something the runtime is told.
    const response = items.find((item) => item.role === 'implementer-response')!;
    assert.notEqual(response.source.kind, 'none');
    const sendKey = response.source.kind === 'none' ? '' : response.source.operationKey!;
    const send = await run(projection.getOperation(runId, sendKey));
    assert.equal(send.operation.provenance.harness, 'claude');
    assert.equal(
      send.operation.provenance.cwd,
      harness.fixture.worktreeDirectory,
      'the session ran in the run\u2019s own worktree',
    );
    assert.ok(send.operation.provenance.runtime, 'a durable runtime identity is stamped');
    assert.ok(send.operation.provenance.runtime!.runtimeId.length > 0);
    assert.ok(send.operation.provenance.runtime!.incarnationId.length > 0);
    assert.ok(
      send.operation.provenance.harnessSessionId,
      'the send correlated to the harness session it reached',
    );
    assert.equal(send.operation.provenance.attribution, 'inferred_by_watermark');
    assert.equal(send.operation.provenance.usage, null, 'an interactive turn reports no usage');

    // The Claude headless stub: session id and the five-field usage block, parsed by the real
    // extractor from the body the provider printed.
    const commit = items.find((item) => item.role === 'commit')!;
    assert.notEqual(commit.source.kind, 'none');
    const commitKey = commit.source.kind === 'none' ? '' : commit.source.operationKey!;
    const headless = await run(projection.getOperation(runId, commitKey));
    assert.equal(headless.operation.provenance.harness, 'claude');
    assert.equal(headless.operation.provenance.harnessSessionId, 'claude-session-commit');
    assert.deepEqual(headless.operation.provenance.usage, {
      inputTokens: 12,
      outputTokens: 34,
      cacheReadInputTokens: 5678,
      cacheCreationInputTokens: 90,
      costUsd: 0.42,
    });
  });
});

// --- criterion 7: the listing answers every scope the inspector will ask it -------------------------

test('listing by run, execution, subtree, role and label returns the right sets and carries no content', async () => {
  await withHarness(async (harness) => {
    seedWorktree(harness);
    publishPhaseWiseReview(harness);
    harness.adapters.conversationHistory = [
      { role: 'assistant', parts: [{ type: 'text', text: 'scoped text', state: 'done' }] },
    ];
    const runId = await launchPhaseWise(harness, { phases: 2, reviewLimit: 1 });
    await drivePipeline(harness, runId, verdicts(), { maxPasses: 200 });
    assert.equal((await harness.runOf(runId)).status, 'done');

    const all = await listAll(harness, runId);
    // Two phases: two of everything phase-scoped, plus the two root captures.
    // Per phase: implementer response, review feedback, fixer response, verification, commit.
    assert.equal(all.length, 2 + 2 * 5, `unexpected tree: ${JSON.stringify(shape(all))}`);

    // No content anywhere on the wire, at any scope. The list is metadata.
    const serialised = JSON.stringify(all);
    assert.ok(!serialised.includes('scoped text'), 'a listing must never carry captured content');
    assert.ok(!serialised.includes('pnpm check'), 'not even for a small JSON capture');

    // By role, across both phases.
    const commits = await listAll(harness, runId, { role: 'commit' });
    assert.deepEqual(commits.map((item) => item.labels.phase).sort(), [1, 2]);

    // By label, collapsing representations — `phase:1` matches the number the author wrote.
    const phaseOne = await listAll(harness, runId, { label: ['phase:1'] });
    assert.equal(phaseOne.length, 5);
    assert.ok(phaseOne.every((item) => item.labels.phase === 1));

    // By execution: exactly the captures one callback made.
    const plan = all.find((item) => item.role === 'plan')!;
    const byExecution = await listAll(harness, runId, { executionId: plan.executionId });
    assert.deepEqual(shape(byExecution), ['decision-log{}', 'plan{}']);

    // By subtree from the phase visit: everything beneath that subgraph node, and nothing above it.
    const frames = await run(harness.fixture.runs.listFrames(runId));
    const root = frames.find((frame) => frame.depth === 0)!;
    const rootExecutions = await run(harness.fixture.runs.listExecutions(root.id));
    const firstPhaseVisit = rootExecutions.find((execution) => execution.nodeId === 'phase')!;
    const subtree = await listAll(harness, runId, {
      executionId: firstPhaseVisit.id,
      subtree: true,
    });
    assert.deepEqual(shape(subtree), [
      'commit{"phase":1}',
      'fixer-response{"phase":1,"round":1}',
      'implementer-response{"phase":1}',
      'review-feedback{"phase":1,"round":1}',
      'verification{"phase":1}',
    ]);

    // And it pages: `listAll` asked for five at a time and had to follow a cursor to see them all.
    const firstPage = await run(projectionOf(harness).listEvidence(runId, { limit: 5 }));
    assert.equal(firstPage.items.length, 5);
    assert.ok(firstPage.nextCursor, 'a listing longer than one page hands back a cursor');
  });
});

// --- a contentless assertion about the operation row itself ------------------------------------------

test('a capture operation records its position without the captured bytes in its identity', async () => {
  await withHarness(async (harness) => {
    seedWorktree(harness);
    publishPhaseWiseReview(harness);
    harness.adapters.conversationHistory = [
      { role: 'assistant', parts: [{ type: 'text', text: 'identity text', state: 'done' }] },
    ];
    const runId = await launchPhaseWise(harness, { phases: 1, reviewLimit: 1 });
    await drivePipeline(harness, runId, verdicts(1), { maxPasses: 120 });

    const response = evidenceRows(harness).find((row) => row.role === 'implementer-response')!;
    const operation = (await run(harness.fixture.operations.findById(response.operation_id)))!;
    assert.equal(operation.capability, 'capture_evidence');
    const request = JSON.stringify(await run(harness.fixture.payloads.resolve(operation.request!)));
    assert.ok(
      !request.includes('identity text'),
      `the captured bytes are in the recorded request: ${request}`,
    );
    assert.ok(
      !request.includes('paneId'),
      'the handle the author passed back carries a pane id, which must not reach the identity',
    );
    assert.ok(request.includes('implementer-response'), 'the role is part of the identity');

    // And the bytes really are where the row says they are.
    assert.ok(contentPathFor(harness.fixture.contentRoot, response.content_ref).length > 0);
  });
});
