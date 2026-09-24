import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
} from '@yourtechbudstudio/isagi-workflow-sdk';

import { contentPathFor, run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { makeEngineHarness, type EngineHarness } from './test-support.js';

/**
 * `ctx.captureEvidence` through the whole engine, on a real database and a real worktree directory.
 *
 * Scope is deliberately "the verb works": four content kinds, the row a capture leaves, the source
 * it resolves, and the one recovery claim the story turns on — a callback that fails after
 * capturing gets the *same* reference back on Retry rather than a newer response. Deeper recovery,
 * immutability and partial-failure matrices belong to the fixtures, not here.
 */

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

interface EvidenceRow {
  readonly evidence_key: string;
  readonly run_id: number;
  readonly frame_id: number;
  readonly execution_id: number;
  readonly attempt_id: number;
  readonly operation_id: number;
  readonly artifact_hash: string;
  readonly title: string;
  readonly role: string;
  readonly labels_json: string;
  readonly content_kind: string;
  readonly media_type: string;
  readonly byte_size: number;
  readonly content_ref: string;
  readonly source_path: string | null;
  readonly source_kind: string;
  readonly source_agent_session_id: number | null;
  readonly source_operation_id: number | null;
  readonly source_attribution: string;
  readonly captured_at: string;
}

const evidenceRows = (harness: EngineHarness): EvidenceRow[] =>
  harness.fixture.client
    .prepare('SELECT * FROM workflow_evidence ORDER BY id')
    .all() as EvidenceRow[];

const byRole = (harness: EngineHarness, role: string): EvidenceRow => {
  const found = evidenceRows(harness).filter((row) => row.role === role);
  assert.equal(found.length, 1, `expected exactly one ${role} capture`);
  return found[0]!;
};

/** The bytes as they are actually stored, read back through the content store's own layout. */
const storedBytes = (harness: EngineHarness, row: EvidenceRow): Buffer =>
  readFileSync(contentPathFor(harness.fixture.contentRoot, row.content_ref));

/** Captures one of each content kind, plus a `file` read from the run's real worktree. */
function capturingWorkflow(): AnyWorkflowDefinition {
  const graph = createGraph<
    { readonly captured: number },
    { readonly captured: number },
    Record<string, unknown>
  >({
    key: 'capturing',
    title: 'Capturing',
    init: () => ({ captured: 0 }),
    state: { captured: reduce.add() },
    entry: 'keep',
    nodes: {
      keep: operation(async (ctx) => {
        const session = await ctx.spawnAgentSession({ harness: 'claude', prompt: 'do the work' });
        await ctx.captureEvidence({
          title: 'The response',
          role: 'implementer-response',
          labels: { phase: 1, final: false },
          content: { kind: 'text', text: 'the implementer said this' },
          // The natural authoring shape: hand back the handle already held. Its `paneId` must not
          // reach the recorded identity.
          source: { kind: 'agent_turn', target: session },
        });
        await ctx.captureEvidence({
          title: 'Verification',
          role: 'verification',
          content: { kind: 'json', value: { command: 'pnpm check', exitCode: 0 } },
        });
        await ctx.captureEvidence({
          title: 'A rendered chart',
          role: 'chart',
          content: {
            kind: 'bytes',
            bytes: new Uint8Array([137, 80, 78, 71]),
            mediaType: 'image/png',
          },
        });
        await ctx.captureEvidence({
          title: 'The plan',
          role: 'plan',
          content: { kind: 'file', path: './docs/../docs/plan.md' },
        });
        return complete({ update: { captured: 4 } });
      }),
    },
    edges: {
      'keep-out': edge({ from: 'keep', to: ['kept'], choose: () => ({ to: 'kept' }) }),
    },
    outcomes: {
      kept: outcome({ kind: 'success', output: (state) => ({ captured: state.captured }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Capturing' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

test('every content kind is captured, referenced, and recorded with its placement', async () => {
  await withHarness(async (harness) => {
    seedPlan(harness, '# the plan');

    harness.publish({ workflowKey: 'capturing', version: '1', definition: capturingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'capturing' });
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done', 'the run completed; nothing was rejected');

    const rows = evidenceRows(harness);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.match(row.evidence_key, /^wev_[0-9a-f-]{36}$/);
      assert.match(row.content_ref, /^sha256:[0-9a-f]{64}$/);
      assert.ok(row.run_id > 0 && row.frame_id > 0 && row.execution_id > 0 && row.attempt_id > 0);
      assert.ok(row.operation_id > 0);
      assert.ok(row.artifact_hash.length > 0);
      assert.ok(row.captured_at.length > 0);
    }
    // One capture, one operation: the unique index says at most one, the transaction says at least.
    assert.equal(new Set(rows.map((row) => row.operation_id)).size, 4);

    const text = byRole(harness, 'implementer-response');
    assert.equal(text.content_kind, 'text');
    assert.equal(text.media_type, 'text/plain');
    assert.deepEqual(JSON.parse(text.labels_json), { final: false, phase: 1 });
    assert.equal(storedBytes(harness, text).toString('utf8'), 'the implementer said this');
    assert.equal(text.byte_size, 'the implementer said this'.length);

    const json = byRole(harness, 'verification');
    assert.equal(json.media_type, 'application/json');
    assert.equal(
      storedBytes(harness, json).toString('utf8'),
      '{"command":"pnpm check","exitCode":0}',
    );
    assert.deepEqual(JSON.parse(json.labels_json), {}, 'no labels is an empty object, never null');

    const bytes = byRole(harness, 'chart');
    assert.equal(bytes.media_type, 'image/png');
    assert.deepEqual([...storedBytes(harness, bytes)], [137, 80, 78, 71]);

    const file = byRole(harness, 'plan');
    assert.equal(file.media_type, 'text/markdown');
    // The **requested** path, normalised — not the realpath the bytes were read from. The record
    // says what the author named; the bytes came from what that name resolved to.
    assert.equal(file.source_path, 'docs/plan.md');
    assert.equal(storedBytes(harness, file).toString('utf8'), '# the plan');
  });
});

test('a source handed back as a session handle resolves exactly, without its pane id', async () => {
  await withHarness(async (harness) => {
    seedPlan(harness, '# the plan');
    harness.publish({ workflowKey: 'capturing', version: '1', definition: capturingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'capturing' });
    await harness.drain();

    const row = byRole(harness, 'implementer-response');
    assert.equal(row.source_kind, 'agent_turn');
    assert.equal(row.source_attribution, 'exact');
    assert.ok(row.source_agent_session_id !== null);
    // Resolved to the spawn that produced the turn, in this run.
    const spawn = harness.fixture.client
      .prepare('SELECT capability, run_id FROM workflow_operations WHERE id = ?')
      .get(row.source_operation_id) as { capability: string; run_id: number };
    assert.equal(spawn.capability, 'spawn_agent_session');
    assert.equal(spawn.run_id, launched.id);

    // A capture with no source says so honestly rather than guessing.
    const unsourced = byRole(harness, 'verification');
    assert.equal(unsourced.source_kind, 'none');
    assert.equal(unsourced.source_attribution, 'none');
    assert.equal(unsourced.source_operation_id, null);

    // `paneId` travelled in on the handle and must not have reached the recorded identity, or an
    // author refactoring to a bare `{ agentSessionId, sentAt }` would be refused on Retry.
    const request = harness.fixture.client
      .prepare('SELECT request_inline FROM workflow_operations WHERE id = ?')
      .get(row.operation_id) as { request_inline: string };
    assert.equal(request.request_inline.includes('paneId'), false);
  });
});

/**
 * A callback that fails *after* capturing, with a newer response waiting on the second pass.
 *
 * This is criterion 5 in one test: the captured bytes are not part of the call identity, so the
 * repaired position matches and hands back the recorded reference — and the newer text, which the
 * callback really does read, is never substituted for the judgment that was actually kept.
 */
function throwAfterCaptureWorkflow(): AnyWorkflowDefinition {
  const graph = createGraph<
    { readonly passes: number; readonly lastRead: string | null },
    { readonly passes: number; readonly lastRead: string | null },
    Record<string, unknown>
  >({
    key: 'fragile',
    title: 'Fragile',
    init: () => ({ passes: 0, lastRead: null }),
    state: { passes: reduce.add(), lastRead: reduce.replace<string | null>() },
    entry: 'read',
    nodes: {
      read: operation(async (ctx) => {
        const session = await ctx.spawnAgentSession({ harness: 'claude', prompt: 'review it' });
        // A scoped read: it may legitimately answer differently on the second pass, which is the
        // whole hazard the positional identity exists to contain.
        const history = await ctx.getConversationHistory(session.agentSessionId);
        const latest =
          history
            .at(-1)
            ?.parts.map((part) => part.text)
            .join('') ?? '';
        await ctx.captureEvidence({
          title: 'Reviewer feedback',
          role: 'review-feedback',
          content: { kind: 'text', text: latest },
          source: { kind: 'agent_turn', target: session },
        });
        if (ctx.invocation.attempt === 1) throw new Error('crashed after capturing');
        // Recorded so the test can prove the second pass genuinely read something newer. Without
        // this the Retry assertion would pass even if both passes saw identical text, which would
        // make it evidence of nothing.
        return complete({ update: { passes: 1, lastRead: latest } });
      }),
    },
    edges: {
      'read-out': edge({ from: 'read', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: {
      done: outcome({
        kind: 'success',
        output: (state) => ({ passes: state.passes, lastRead: state.lastRead }),
      }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Fragile' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

test('Retry returns the recorded capture, not the newer response the callback now reads', async () => {
  await withHarness(async (harness) => {
    harness.adapters.conversationHistory = [
      { role: 'assistant', parts: [{ type: 'text', text: 'round one verdict', state: 'done' }] },
    ];
    harness.publish({
      workflowKey: 'fragile',
      version: '1',
      definition: throwAfterCaptureWorkflow(),
    });
    const launched = await harness.launch({ workflowKey: 'fragile' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.status, 'failed');
    const first = evidenceRows(harness);
    assert.equal(first.length, 1);
    assert.equal(storedBytes(harness, first[0]!).toString('utf8'), 'round one verdict');

    // The conversation genuinely moves on between the two passes. Without this the test would pass
    // even if the runtime re-read and re-captured, which is exactly what it exists to refuse.
    const session = harness.fixture.client
      .prepare(`SELECT target_id FROM workflow_operations WHERE capability = 'spawn_agent_session'`)
      .get() as { target_id: number };
    harness.conversation.set(session.target_id, 'round two verdict, newer');

    await harness.retry(launched.id);
    await harness.drain();

    const repaired = await harness.runOf(launched.id);
    assert.equal(repaired.status, 'done');
    // The callback really did see the newer text on the second pass. This is what stops the
    // assertions below from being a tautology about a conversation that never moved.
    const output = (await run(harness.fixture.payloads.resolve(repaired.output!))) as {
      lastRead: string;
    };
    assert.equal(
      output.lastRead,
      'round two verdict, newer',
      'the second pass read the newer response',
    );

    const after = evidenceRows(harness);
    assert.equal(after.length, 1, 'exactly one evidence row at that call position');
    assert.equal(after[0]!.evidence_key, first[0]!.evidence_key, 'the same reference came back');
    assert.equal(
      storedBytes(harness, after[0]!).toString('utf8'),
      'round one verdict',
      'the judgment that was kept, never the newer one',
    );
  });
});

/** A real file in the run's real worktree, which is what a `file` capture streams from. */
function seedPlan(harness: EngineHarness, body: string) {
  mkdirSync(join(harness.fixture.worktreeDirectory, 'docs'), { recursive: true });
  writeFileSync(join(harness.fixture.worktreeDirectory, 'docs', 'plan.md'), body);
}

/** A `file` capture in a callback that fails after it, so a Retry re-enters the same position. */
function fragileFileWorkflow(): AnyWorkflowDefinition {
  const graph = createGraph<
    { readonly passes: number },
    { readonly passes: number },
    Record<string, unknown>
  >({
    key: 'fragile-file',
    title: 'Fragile file',
    init: () => ({ passes: 0 }),
    state: { passes: reduce.add() },
    entry: 'keep',
    nodes: {
      keep: operation(async (ctx) => {
        await ctx.captureEvidence({
          title: 'The plan',
          role: 'plan',
          content: { kind: 'file', path: 'docs/plan.md' },
        });
        if (ctx.invocation.attempt === 1) throw new Error('crashed after capturing');
        return complete({ update: { passes: 1 } });
      }),
    },
    edges: {
      'keep-out': edge({ from: 'keep', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: {
      done: outcome({ kind: 'success', output: (state) => ({ passes: state.passes }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Fragile file' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

test('a recorded file capture is reused after its source is deleted', async () => {
  await withHarness(async (harness) => {
    seedPlan(harness, '# the plan');
    harness.publish({
      workflowKey: 'fragile-file',
      version: '1',
      definition: fragileFileWorkflow(),
    });
    const launched = await harness.launch({ workflowKey: 'fragile-file' });
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'failed');
    const original = evidenceRows(harness);
    assert.equal(original.length, 1);

    // The source is gone. The reuse branch must return before any filesystem access, or the
    // repaired segment would fail on a file whose bytes were already captured — which would make
    // "evidence outlives its source" untrue exactly when it matters.
    rmSync(join(harness.fixture.worktreeDirectory, 'docs', 'plan.md'));

    await harness.retry(launched.id);
    await harness.drain();

    assert.equal((await harness.runOf(launched.id)).status, 'done');
    const after = evidenceRows(harness);
    assert.equal(after.length, 1, 'no second capture at that position');
    assert.equal(after[0]!.evidence_key, original[0]!.evidence_key);
    assert.equal(storedBytes(harness, after[0]!).toString('utf8'), '# the plan');
  });
});
