import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import type { EngineHarness } from '../../engine/test-support.js';
import { run } from '../../persistence/test-support.js';
import {
  drivePipeline,
  evidenceContent,
  evidenceRows,
  evidenceShape as shape,
  evidenceText,
  listAllEvidence as listAll,
  projectionOf,
  withHarness,
} from '../drive.js';
import { publishSolutionWalkthrough } from './drive.js';
import { renderCover } from './index.js';

/**
 * `solution-walkthrough`, end to end: what survives its own source file being rewritten.
 *
 * The authored flow this derives from overwrites one `walkthrough.html` in place across sessions.
 * The assertions here are therefore about the gap between *the file on disk* and *the record*: once
 * a capture has returned, the two are independent, and the record is the one a person can still
 * read.
 */

const CURRICULUM = { title: 'Graph execution', lessons: ['frames', 'executions', 'operations'] };
const DECK_PLAN = {
  neighborhoods: [{ id: 'frames' }, { id: 'operations' }],
};

function seedPlans(harness: EngineHarness) {
  const root = harness.fixture.worktreeDirectory;
  const write = (relative: string, value: unknown) => {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, JSON.stringify(value, null, 2), 'utf8');
  };
  write('plan/curriculum.json', CURRICULUM);
  write('plan/deck-plan.json', DECK_PLAN);
  return root;
}

async function launchWalkthrough(harness: EngineHarness): Promise<number> {
  const launched = await harness.launch({
    workflowKey: 'solution-walkthrough',
    inputs: {
      curriculumPath: 'plan/curriculum.json',
      deckPlanPath: 'plan/deck-plan.json',
      outputPath: 'walkthrough.html',
    },
  });
  return launched.id;
}

/** The walkthrough asks for no judgments; every wait it arms is an agent turn. */
const noJudgments = () => 'unused';

const EXPECTED_TREE = [
  'builder-response{"index":1,"neighborhood":"frames"}',
  'builder-response{"index":2,"neighborhood":"operations"}',
  'cover{}',
  'curriculum{}',
  'deck-plan{}',
  'metrics{}',
  'presentation{}',
  'validation{"index":1,"neighborhood":"frames"}',
  'validation{"index":2,"neighborhood":"operations"}',
];

// --- the happy run --------------------------------------------------------------------------------

test('a walkthrough keeps its plans, every neighborhood, the presentation and its cover', async () => {
  await withHarness(async (harness) => {
    seedPlans(harness);
    publishSolutionWalkthrough(harness);
    harness.adapters.conversationHistory = [
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'built the frames part', state: 'done' }],
      },
    ];
    const runId = await launchWalkthrough(harness);

    const finished = await drivePipeline(harness, runId, noJudgments, { maxPasses: 80 });
    assert.equal(finished.status, 'done');
    assert.equal(finished.outcomeId, 'published');

    const items = await listAll(harness, runId);
    assert.deepEqual(shape(items), EXPECTED_TREE);

    // Criterion 1: all four content kinds, across the two fixtures, are reached. This is the one
    // that only this fixture produces — raw bytes that are neither text nor a file on disk.
    assert.deepEqual([...new Set(items.map((item) => item.content.kind))].sort(), [
      'bytes',
      'file',
      'json',
      'text',
    ]);
    const cover = items.find((item) => item.role === 'cover')!;
    assert.equal(cover.content.mediaType, 'image/png');
    assert.equal(cover.content.sourcePath, null, 'bytes came from memory, not from a path');
    assert.deepEqual(
      [...(await evidenceContent(harness, runId, cover.evidenceKey))],
      [...renderCover(DECK_PLAN.neighborhoods.map((entry) => entry.id))],
    );

    // The presentation is an HTML file capture, and its media type is the author's declaration
    // rather than anything read off the digest.
    const presentation = items.find((item) => item.role === 'presentation')!;
    assert.equal(presentation.content.kind, 'file');
    assert.equal(presentation.content.mediaType, 'text/html');
    assert.equal(presentation.content.sourcePath, 'walkthrough.html');
    const html = await evidenceText(harness, runId, presentation.evidenceKey);
    assert.match(html, /data-moment="frames"/);
    assert.match(html, /data-moment="operations"/);

    // The metrics were computed over that same string, so the two records agree by construction.
    const metrics = JSON.parse(
      await evidenceText(
        harness,
        runId,
        items.find((item) => item.role === 'metrics')!.evidenceKey,
      ),
    ) as { planned: number; realized: number; missing: string[]; bytes: number };
    assert.deepEqual(metrics, {
      planned: 2,
      realized: 2,
      missing: [],
      bytes: Buffer.byteLength(html, 'utf8'),
    });

    // A fresh session per neighborhood, each attributed exactly to the spawn that produced it.
    const builders = items.filter((item) => item.role === 'builder-response');
    const sessions = builders.map((item) =>
      item.source.kind === 'none' ? null : item.source.agentSessionId,
    );
    assert.equal(new Set(sessions).size, 2, 'two neighborhoods, two distinct sessions');
    assert.ok(builders.every((item) => item.source.kind === 'agent_turn'));
  });
});

// --- criterion 2: the record outlives the file ------------------------------------------------------

test('captured bytes survive the source file being overwritten and then deleted', async () => {
  await withHarness(async (harness) => {
    const worktree = seedPlans(harness);
    publishSolutionWalkthrough(harness, { mutateAfterCapture: true });
    const runId = await launchWalkthrough(harness);

    const finished = await drivePipeline(harness, runId, noJudgments, { maxPasses: 80 });
    assert.equal(finished.status, 'done', 'mutating the source is not a failure; it is ordinary');

    // The file the capture named is gone. Nothing on the read path may need it.
    assert.equal(existsSync(join(worktree, 'walkthrough.html')), false);

    const presentation = (await listAll(harness, runId)).find(
      (item) => item.role === 'presentation',
    )!;
    const served = await evidenceText(harness, runId, presentation.evidenceKey);
    assert.match(served, /data-moment="frames"/, 'the original bytes, not the overwrite');
    assert.doesNotMatch(served, /overwritten/);

    // Verified on the way out: the digest the row carries is the digest of what was streamed.
    const row = evidenceRows(harness).find(
      (candidate) => candidate.evidence_key === presentation.evidenceKey,
    )!;
    assert.match(row.content_ref, /^sha256:[0-9a-f]{64}$/);
    assert.equal(row.byte_size, Buffer.byteLength(served, 'utf8'));
    assert.equal(
      row.source_path,
      'walkthrough.html',
      'the row records the relative path that was requested, not an absolute one',
    );
    assert.ok(!row.source_path.startsWith('/'));
  });
});

// --- criteria 2 and 5: repaired without touching the filesystem ---------------------------------------

test('a file capture whose callback fails is repaired after the file is deleted', async () => {
  await withHarness(async (harness) => {
    const worktree = seedPlans(harness);
    publishSolutionWalkthrough(harness, { mutateAfterCapture: true, failAfterCapture: true });
    const runId = await launchWalkthrough(harness);

    await drivePipeline(harness, runId, noJudgments, { maxPasses: 80 });
    const failed = await harness.runOf(runId);
    assert.equal(failed.status, 'failed');

    const captured = evidenceRows(harness).filter((row) => row.role === 'presentation');
    assert.equal(captured.length, 1, 'the capture committed although the callback did not');
    const original = captured[0]!;
    assert.equal(existsSync(join(worktree, 'walkthrough.html')), false);

    // The repair cannot re-read the file, because there is no file. If the reuse branch did any
    // filesystem work at all, this Retry would fail with `path_not_found`.
    const control = await harness.retry(runId);
    assert.equal(control.accepted, true, JSON.stringify(control));
    const repaired = await drivePipeline(harness, runId, noJudgments, { maxPasses: 80 });
    assert.equal(repaired.status, 'done', 'the repaired callback never went near the filesystem');

    const after = evidenceRows(harness).filter((row) => row.role === 'presentation');
    assert.equal(after.length, 1, 'one row at that call position, before and after');
    assert.equal(after[0]!.evidence_key, original.evidence_key);
    assert.equal(after[0]!.content_ref, original.content_ref);
    assert.match(
      await evidenceText(harness, runId, original.evidence_key),
      /data-moment="operations"/,
    );

    // And the run really did finish the rest of the node it had abandoned.
    assert.deepEqual(shape(await listAll(harness, runId)), EXPECTED_TREE);
  });
});

// --- criterion 10: evidence does not live behind the session ledger ------------------------------------

test('deleting a session ledger directory does not affect any evidence read', async () => {
  await withHarness(async (harness) => {
    seedPlans(harness);
    publishSolutionWalkthrough(harness);
    harness.adapters.conversationHistory = [
      { role: 'assistant', parts: [{ type: 'text', text: 'neighborhood text', state: 'done' }] },
    ];
    const runId = await launchWalkthrough(harness);
    await drivePipeline(harness, runId, noJudgments, { maxPasses: 80 });
    assert.equal((await harness.runOf(runId)).status, 'done');

    const builder = (await listAll(harness, runId)).find(
      (item) => item.role === 'builder-response',
    )!;
    assert.notEqual(builder.source.kind, 'none');
    const agentSessionId = builder.source.kind === 'none' ? 0 : builder.source.agentSessionId!;
    assert.ok(agentSessionId > 0);

    // Session GC removes the ledger directory **by agent session id**, so the directory named here
    // is provably the one belonging to the session that produced this very record — not some other
    // path that happens to be safe to delete. The layout is recreated rather than driven through
    // the real service, because the durable effect under test is a recursive removal and standing
    // the service up inside the engine harness would buy nothing else.
    const ledgerRoot = join(harness.fixture.root, 'sessions', 'agent-sessions');
    const directory = join(ledgerRoot, String(agentSessionId));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'harness.json'), '{"harnessSessionId":"gone"}', 'utf8');
    writeFileSync(join(directory, 'session.jsonl'), '{"seq":1}\n', 'utf8');
    assert.equal(readdirSync(directory).length, 2);

    // The structural guarantee behind the behavioural one: the bytes are not under the ledger, so
    // a recursive removal there cannot reach them however thorough it is.
    assert.ok(
      !harness.fixture.contentRoot.startsWith(ledgerRoot),
      'the content store must not live under the session ledger',
    );

    rmSync(ledgerRoot, { recursive: true, force: true });
    assert.equal(existsSync(directory), false);

    // Every record still lists, and every one of them still streams and verifies.
    const items = await listAll(harness, runId);
    assert.deepEqual(shape(items), EXPECTED_TREE);
    for (const item of items) {
      const bytes = await evidenceContent(harness, runId, item.evidenceKey);
      assert.equal(bytes.byteLength, item.content.byteSize, `${item.role} changed size`);
    }
    assert.equal(
      await evidenceText(harness, runId, builder.evidenceKey),
      'neighborhood text',
      'a captured agent response is readable after its conversation ledger is gone',
    );
  });
});

// --- criterion 7: the listing, from this fixture's side ------------------------------------------------

test('walkthrough evidence lists by run, execution, subtree, role and label, and pages', async () => {
  await withHarness(async (harness) => {
    seedPlans(harness);
    publishSolutionWalkthrough(harness);
    harness.adapters.conversationHistory = [
      { role: 'assistant', parts: [{ type: 'text', text: 'listed text', state: 'done' }] },
    ];
    const runId = await launchWalkthrough(harness);
    await drivePipeline(harness, runId, noJudgments, { maxPasses: 80 });

    const all = await listAll(harness, runId);
    assert.equal(all.length, EXPECTED_TREE.length);
    const serialised = JSON.stringify(all);
    assert.ok(!serialised.includes('listed text'), 'a listing carries metadata, never content');
    assert.ok(!serialised.includes('data-moment'), 'not even for the HTML presentation');

    // By role.
    assert.equal((await listAll(harness, runId, { role: 'validation' })).length, 2);

    // By label, with a string value — the filter collapses representations in both directions.
    const frames = await listAll(harness, runId, { label: ['neighborhood:frames'] });
    assert.deepEqual(shape(frames), [
      'builder-response{"index":1,"neighborhood":"frames"}',
      'validation{"index":1,"neighborhood":"frames"}',
    ]);
    // …and by a numeric one, which the author wrote as a number and the filter reads as text.
    assert.deepEqual(shape(await listAll(harness, runId, { label: ['index:2'] })), [
      'builder-response{"index":2,"neighborhood":"operations"}',
      'validation{"index":2,"neighborhood":"operations"}',
    ]);
    // Two labels together narrow rather than widen.
    assert.deepEqual(
      shape(await listAll(harness, runId, { label: ['index:2', 'neighborhood:operations'] })),
      [
        'builder-response{"index":2,"neighborhood":"operations"}',
        'validation{"index":2,"neighborhood":"operations"}',
      ],
    );

    // By execution: exactly the three captures `assemble` made in one callback.
    const presentation = all.find((item) => item.role === 'presentation')!;
    assert.deepEqual(
      shape(await listAll(harness, runId, { executionId: presentation.executionId })),
      ['cover{}', 'metrics{}', 'presentation{}'],
    );

    // By subtree from a neighborhood visit: what that child frame produced, and nothing else.
    const frameList = await run(harness.fixture.runs.listFrames(runId));
    const root = frameList.find((frame) => frame.depth === 0)!;
    const visits = (await run(harness.fixture.runs.listExecutions(root.id))).filter(
      (execution) => execution.nodeId === 'neighborhood',
    );
    assert.equal(visits.length, 2, 'one visit per neighborhood, each its own execution');
    assert.deepEqual(
      shape(await listAll(harness, runId, { executionId: visits[0]!.id, subtree: true })),
      [
        'builder-response{"index":1,"neighborhood":"frames"}',
        'validation{"index":1,"neighborhood":"frames"}',
      ],
    );

    // And it pages: nine records at five per page needs a cursor.
    const firstPage = await run(projectionOf(harness).listEvidence(runId, { limit: 5 }));
    assert.equal(firstPage.items.length, 5);
    assert.ok(firstPage.nextCursor);
  });
});
