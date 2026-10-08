import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  checkpoint,
  createGraph,
  defineWorkflow,
  edge,
  outcome,
  reduce,
  type CheckpointPlan,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { eq } from 'drizzle-orm';
import { Cause, Effect, Exit } from 'effect';

import { workflowCheckpoints } from '../../persistence/schema.js';
import { withEngine, type EngineHarness } from '../engine/test-support.js';
import { WorkflowEngineError } from '../errors.js';
import { listReferencedContentHashes } from '../store/checkpoints.js';
import { contentPathFor, type ContentGcResult } from '../store/content-store.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';

/**
 * Checkpoint capture, reads and export, against real Git in a temporary repository and a real
 * content store. Only agents and surfaces are faked.
 */

interface SaveState {
  readonly saved: boolean;
}

/**
 * One checkpoint node routed to one outcome; `choose` lets a test fail the pure step after it, and
 * `label` is the node's dynamic label, if any.
 */
function checkpointWorkflow(
  plan: () => CheckpointPlan,
  choose: () => { to: 'done' },
  label?: () => string,
) {
  const graph = createGraph<SaveState, {}, {}, null>({
    key: 'save',
    title: 'Save',
    init: () => ({ saved: false }),
    state: { saved: reduce.replace<boolean>() },
    entry: 'save',
    nodes: { save: checkpoint({ title: 'Save', plan, label }) },
    edges: { 'save-out': edge({ from: 'save', to: ['done'], choose }) },
    outcomes: { done: outcome({ kind: 'success', output: () => null }) },
  });
  return defineWorkflow({
    command: () => ({ title: 'Checkpoint' }),
    parse: () => ({}),
    graph,
  }) as unknown as AnyWorkflowDefinition;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A repository whose HEAD holds `files`, all committed. */
function commitRepository(root: string, files: Record<string, string>): string {
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, 'add', '--all');
  git(root, 'commit', '--quiet', '-m', 'base');
  return git(root, 'rev-parse', 'HEAD');
}

async function withExportRoot(body: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'isagi-checkpoint-export-'));
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function launchAndSettle(
  harness: EngineHarness,
  key: string,
  definition: AnyWorkflowDefinition,
) {
  harness.registry.publish(key, definition);
  const runId = await harness.launch(key);
  const { run } = await harness.run(harness.engine.getRun(runId));
  return { runId, run };
}

function listTree(root: string, relative = ''): string[] {
  const entries: string[] = [];
  const directory = join(root, relative);
  for (const name of execFileSync('ls', ['-A', directory], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)) {
    if (name === '.git') continue;
    const path = relative ? `${relative}/${name}` : name;
    if (statSync(join(root, path)).isDirectory()) entries.push(...listTree(root, path));
    else entries.push(path);
  }
  return entries.sort();
}

test('a checkpoint copies exactly its scopes, and export rebuilds them exactly', async () => {
  await withEngine(async (harness) => {
    const root = harness.worktreePath;
    const commit = commitRepository(root, {
      'notes/plan.md': 'committed plan\n',
      'notes/stale.md': 'deleted before capture\n',
      'notes/cache/committed.txt': 'excluded, left alone\n',
      'tool.sh': 'echo committed\n',
      'gone/old.txt': 'the whole scope is gone at capture\n',
      'other.txt': 'outside every scope\n',
    });
    // The working tree at capture differs from the commit in every way export must repair.
    write(root, 'notes/plan.md', 'working plan\n');
    write(root, 'notes/new/idea.md', 'untracked idea\n');
    rmSync(join(root, 'notes/stale.md'));
    write(root, 'notes/cache/local.txt', 'excluded, never captured\n');
    write(root, 'tool.sh', 'echo working\n');
    chmodSync(join(root, 'tool.sh'), 0o755);
    rmSync(join(root, 'gone'), { recursive: true });
    symlinkSync('plan.md', join(root, 'notes/link.md'));

    const { runId, run } = await launchAndSettle(
      harness,
      'exact',
      checkpointWorkflow(
        () => ({
          capture: [
            { scope: 'notes', directory: 'notes', exclude: ['cache'] },
            { scope: 'tool', file: 'tool.sh' },
            { scope: 'gone', directory: 'gone' },
            { scope: 'absent-file', file: 'never.txt' },
          ],
        }),
        () => ({ to: 'done' }),
        () => 'Exact',
      ),
    );
    assert.equal(run.status, 'completed', JSON.stringify(run.error));

    const listed = await harness.run(harness.engine.listCheckpoints(runId, {}));
    assert.equal(listed.items.length, 1);
    const summary = listed.items[0]!;
    assert.equal(summary.commitSha, commit);
    assert.equal(summary.title, 'Save', "the node's static title");
    assert.equal(summary.label, 'Exact', 'the label captured when the execution was created');
    assert.deepEqual(
      summary.scopes.map((scope) => [scope.scope, scope.missing, scope.fileCount]),
      [
        ['notes', false, 2],
        ['tool', false, 1],
        ['gone', true, 0],
        ['absent-file', true, 0],
      ],
    );

    const { checkpoint: detail } = await harness.run(
      harness.engine.getCheckpoint(summary.checkpointId),
    );
    const notes = detail.scopes[0]!;
    assert.deepEqual(
      notes.files.map((file) => file.path),
      ['notes/new/idea.md', 'notes/plan.md'],
      'the symlink and the excluded cache are not captured',
    );
    assert.equal(detail.scopes[1]!.files[0]!.executable, true);

    const execution = await harness.run(harness.engine.getExecution(detail.executionId));
    assert.equal(execution.execution.checkpointId, detail.checkpointId);
    assert.deepEqual(execution.execution.result, {
      type: 'complete',
      update: {},
      checkpointId: detail.checkpointId,
    });
    assert.equal(execution.execution.label, 'Exact');
    assert.equal(detail.label, 'Exact');
    const events = await harness.run(harness.engine.listEvents(runId, {}));
    const captured = events.items.find(
      (event) =>
        event.kind === 'checkpoint_captured' &&
        (event.data as { checkpointId: number }).checkpointId === detail.checkpointId,
    );
    assert.equal(captured?.message, `Save · Exact: checkpoint ${detail.checkpointId} saved`);

    const file = await harness.run(
      harness.engine.openCheckpointFile(detail.checkpointId, 'notes/plan.md'),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(chunk as Buffer);
    assert.equal(Buffer.concat(chunks).toString(), 'working plan\n');
    const missingFile = await harness.fail(
      harness.engine.openCheckpointFile(detail.checkpointId, 'other.txt'),
    );
    assert.equal((missingFile as WorkflowEngineError).code, 'workflow_checkpoint_file_not_found');

    // Captured files change after capture; the checkpoint does not.
    write(root, 'notes/plan.md', 'changed after capture\n');

    await withExportRoot(async (exportRoot) => {
      const destination = join(exportRoot, 'rebuilt');
      const exported = await harness.run(
        harness.engine.exportCheckpoint(detail.checkpointId, destination),
      );
      assert.notEqual(exported.worktreeId, null);
      const out = exported.destinationPath;
      assert.equal(git(out, 'rev-parse', 'HEAD'), commit);
      assert.deepEqual(listTree(out), [
        'notes/cache/committed.txt',
        'notes/new/idea.md',
        'notes/plan.md',
        'other.txt',
        'tool.sh',
      ]);
      assert.equal(readFileSync(join(out, 'notes/plan.md'), 'utf8'), 'working plan\n');
      assert.equal(readFileSync(join(out, 'tool.sh'), 'utf8'), 'echo working\n');
      assert.notEqual(statSync(join(out, 'tool.sh')).mode & 0o100, 0);
      assert.equal(existsSync(join(out, 'gone')), false, 'a missing scope is absent');

      const again = await harness.fail(
        harness.engine.exportCheckpoint(detail.checkpointId, destination),
      );
      assert.equal((again as WorkflowEngineError).code, 'workflow_checkpoint_destination_rejected');
      assert.equal((again as WorkflowEngineError).destination?.issue, 'not_empty');
      const inside = await harness.fail(
        harness.engine.exportCheckpoint(detail.checkpointId, join(root, 'inside')),
      );
      assert.equal((inside as WorkflowEngineError).destination?.issue, 'inside_checkout');
    });
  });
});

test('export rebuilds the captured shape where the commit has a file for a folder, or the reverse', async () => {
  await withEngine(async (harness) => {
    const root = harness.worktreePath;
    commitRepository(root, {
      docs: 'a file where the checkout later has a folder\n',
      'notes/readme.md/inner.txt': 'a folder where the checkout later has a file\n',
      'stale/kept.txt': 'a folder where a missing file scope points\n',
      'wiki/page.md': 'a folder where a missing directory scope points\n',
    });
    rmSync(join(root, 'docs'));
    write(root, 'docs/page.md', 'page\n');
    rmSync(join(root, 'notes/readme.md'), { recursive: true });
    write(root, 'notes/readme.md', 'readme\n');
    rmSync(join(root, 'stale'), { recursive: true });
    rmSync(join(root, 'wiki'), { recursive: true });
    write(root, 'wiki', 'now a file\n');

    await launchAndSettle(
      harness,
      'shapes',
      checkpointWorkflow(
        () => ({
          capture: [
            { scope: 'docs', directory: 'docs' },
            { scope: 'notes', directory: 'notes' },
            { scope: 'stale', file: 'stale' },
            { scope: 'wiki', directory: 'wiki/sub' },
          ],
        }),
        () => ({ to: 'done' }),
      ),
    );
    const [saved] = harness.db.select().from(workflowCheckpoints).all();
    assert.ok(saved, 'the checkpoint was saved');

    await withExportRoot(async (exportRoot) => {
      const exported = await harness.run(
        harness.engine.exportCheckpoint(saved.id, join(exportRoot, 'shapes')),
      );
      const out = exported.destinationPath;
      assert.deepEqual(listTree(out), ['docs/page.md', 'notes/readme.md', 'wiki/page.md']);
      assert.equal(readFileSync(join(out, 'notes/readme.md'), 'utf8'), 'readme\n');
      assert.equal(existsSync(join(out, 'stale')), false);
    });
  });
});

test('two exports to one folder at once: one writes it, the other is refused', async () => {
  await withEngine(async (harness) => {
    harness.places.projectKind = 'folder';
    write(harness.worktreePath, 'docs/a.md', 'a\n');
    await launchAndSettle(
      harness,
      'twice',
      checkpointWorkflow(
        () => ({ capture: [{ scope: 'docs', directory: 'docs' }] }),
        () => ({ to: 'done' }),
      ),
    );
    const [saved] = harness.db.select().from(workflowCheckpoints).all();
    assert.ok(saved);

    await withExportRoot(async (exportRoot) => {
      const destination = join(exportRoot, 'shared');
      const exits = await Promise.all([
        Effect.runPromiseExit(harness.engine.exportCheckpoint(saved.id, destination)),
        Effect.runPromiseExit(harness.engine.exportCheckpoint(saved.id, destination)),
      ]);
      const refused = exits.filter(Exit.isFailure);
      assert.equal(exits.filter(Exit.isSuccess).length, 1);
      assert.equal(refused.length, 1);
      const failure = Cause.squash(refused[0]!.cause) as WorkflowEngineError;
      assert.equal(failure.code, 'workflow_checkpoint_destination_rejected');
      assert.deepEqual(listTree(destination), ['docs/a.md']);
    });
  });
});

test('two checkpoints of one scope differ as the files did, and --scope lists both', async () => {
  await withEngine(async (harness) => {
    const root = harness.worktreePath;
    commitRepository(root, { 'plan/plan.md': 'v0\n' });
    let round = 0;
    // The edge is pure only by convention; this test uses it to change files between visits.
    const definition = createGraph<{ readonly round: number }, {}, {}, null>({
      key: 'rounds',
      title: 'Rounds',
      init: () => ({ round: 0 }),
      state: { round: reduce.replace<number>() },
      entry: 'save',
      nodes: {
        save: checkpoint({
          label: (state) => `Round ${state.round}`,
          plan: () => ({ capture: [{ scope: 'plan', directory: 'plan' }] }),
        }),
      },
      edges: {
        'save-out': edge({
          from: 'save',
          to: ['save', 'done'],
          choose: () => {
            round += 1;
            if (round === 1) {
              // Between the two captures: one file changes, one is deleted, one appears.
              write(root, 'plan/plan.md', 'v1\n');
              write(root, 'plan/extra.md', 'added\n');
              rmSync(join(root, 'plan/draft.md'));
              return { to: 'save' };
            }
            return { to: 'done' };
          },
        }),
      },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    });
    write(root, 'plan/draft.md', 'first round only\n');
    const { runId, run } = await launchAndSettle(
      harness,
      'rounds',
      defineWorkflow({
        command: () => ({ title: 'Rounds' }),
        parse: () => ({}),
        graph: definition,
      }) as unknown as AnyWorkflowDefinition,
    );
    assert.equal(run.status, 'completed', JSON.stringify(run.error));

    const plans = await harness.run(harness.engine.listCheckpoints(runId, { scope: 'plan' }));
    assert.equal(plans.items.length, 2);
    const none = await harness.run(harness.engine.listCheckpoints(runId, { scope: 'other' }));
    assert.equal(none.items.length, 0);
    const [first, second] = await Promise.all(
      plans.items.map((item) =>
        harness.run(harness.engine.getCheckpoint(item.checkpointId)).then((out) => out.checkpoint),
      ),
    );
    assert.deepEqual(
      first!.scopes[0]!.files.map((file) => file.path),
      ['plan/draft.md', 'plan/plan.md'],
    );
    assert.deepEqual(
      second!.scopes[0]!.files.map((file) => file.path),
      ['plan/extra.md', 'plan/plan.md'],
    );
    const sha = (files: readonly { path: string; sha256: string }[]) =>
      files.find((file) => file.path === 'plan/plan.md')!.sha256;
    assert.notEqual(sha(first!.scopes[0]!.files), sha(second!.scopes[0]!.files));
  });
});

test('a folder project records no commit and exports into a plain folder', async () => {
  await withEngine(async (harness) => {
    harness.places.projectKind = 'folder';
    const root = harness.worktreePath;
    write(root, 'docs/a.md', 'a\n');
    const { run } = await launchAndSettle(
      harness,
      'folder',
      checkpointWorkflow(
        () => ({ capture: [{ scope: 'docs', directory: 'docs' }] }),
        () => ({ to: 'done' }),
      ),
    );
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    const [saved] = harness.db.select().from(workflowCheckpoints).all();
    assert.equal(saved!.commitSha, null);
    assert.equal(saved!.title, 'Save', "the node's static title");
    assert.equal(saved!.label, null, 'a checkpoint without a label stores none');

    await withExportRoot(async (exportRoot) => {
      const exported = await harness.run(
        harness.engine.exportCheckpoint(saved!.id, join(exportRoot, 'plain')),
      );
      assert.equal(exported.worktreeId, null);
      assert.deepEqual(listTree(exported.destinationPath), ['docs/a.md']);
    });
  });
});

test('an unborn repository records no commit', async () => {
  await withEngine(async (harness) => {
    git(harness.worktreePath, 'init', '--quiet');
    write(harness.worktreePath, 'a.txt', 'a\n');
    const { run } = await launchAndSettle(
      harness,
      'unborn',
      checkpointWorkflow(
        () => ({ capture: [{ scope: 'a', file: 'a.txt' }] }),
        () => ({ to: 'done' }),
      ),
    );
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    const [saved] = harness.db.select().from(workflowCheckpoints).all();
    assert.equal(saved!.commitSha, null);
  });
});

test('exporting a checkpoint whose commit is gone fails clearly and creates nothing', async () => {
  await withEngine(async (harness) => {
    commitRepository(harness.worktreePath, { 'a.txt': 'a\n' });
    await launchAndSettle(
      harness,
      'gone',
      checkpointWorkflow(
        () => ({ capture: [{ scope: 'a', file: 'a.txt' }] }),
        () => ({ to: 'done' }),
      ),
    );
    const [saved] = harness.db.select().from(workflowCheckpoints).all();
    const discarded = 'f'.repeat(40);
    harness.db
      .update(workflowCheckpoints)
      .set({ commitSha: discarded })
      .where(eq(workflowCheckpoints.id, saved!.id))
      .run();

    await withExportRoot(async (exportRoot) => {
      const destination = join(exportRoot, 'never');
      const failure = (await harness.fail(
        harness.engine.exportCheckpoint(saved!.id, destination),
      )) as WorkflowEngineError;
      assert.equal(failure.code, 'workflow_checkpoint_commit_unavailable');
      assert.equal(failure.commitSha, discarded);
      assert.match(failure.message, /discarded commit/);
      assert.equal(existsSync(destination), false);
    });
  });
});

test('Retry after a failed capture captures again; Retry after a later failure does not', async () => {
  await withEngine(async (harness) => {
    const root = harness.worktreePath;
    commitRepository(root, { 'keep.txt': 'k\n' });
    // A file where the plan names a directory fails the capture.
    write(root, 'out', 'not a directory\n');
    let edgeThrows = true;
    const { runId, run } = await launchAndSettle(
      harness,
      'heal',
      checkpointWorkflow(
        () => ({ capture: [{ scope: 'out', directory: 'out' }] }),
        () => {
          if (edgeThrows) throw new Error('edge broke');
          return { to: 'done' };
        },
        () => 'Heal',
      ),
    );
    assert.equal(run.status, 'failed');
    assert.equal(run.error?.stage, 'checkpoint_capture');
    assert.match(run.error?.message ?? '', /'out' is not a directory/);
    assert.equal(harness.db.select().from(workflowCheckpoints).all().length, 0);

    // The person fixes the checkout; Retry runs the capture again, then the edge fails.
    rmSync(join(root, 'out'));
    write(root, 'out/result.md', 'r\n');
    await harness.run(harness.engine.retry(runId));
    const afterCapture = (await harness.run(harness.engine.getRun(runId))).run;
    assert.equal(afterCapture.status, 'failed');
    assert.equal(afterCapture.error?.stage, 'edge');
    const captured = harness.db.select().from(workflowCheckpoints).all();
    assert.equal(captured.length, 1);
    // Captured by the retried execution, which carries the label its failed attempt captured.
    assert.equal(captured[0]!.label, 'Heal');

    // Retry copies the saved result: no second capture, even though the files changed.
    write(root, 'out/result.md', 'changed\n');
    edgeThrows = false;
    await harness.run(harness.engine.retry(runId));
    const detail = await harness.run(harness.engine.getRun(runId));
    assert.equal(detail.run.status, 'completed', JSON.stringify(detail.run.error));
    assert.equal(harness.db.select().from(workflowCheckpoints).all().length, 1);
    const saves = detail.executions.filter((execution) => execution.nodeId === 'save');
    assert.equal(saves.length, 3);
    assert.equal(saves[2]!.retryOf, saves[1]!.executionId);
    assert.equal(saves[2]!.checkpointId, captured[0]!.id);
    assert.deepEqual(
      saves.map((save) => save.label),
      ['Heal', 'Heal', 'Heal'],
    );
  });
});

test('a checkpoint label that throws is null and never fails the run', async () => {
  await withEngine(async (harness) => {
    commitRepository(harness.worktreePath, { 'a.txt': 'a\n' });
    const { run } = await launchAndSettle(
      harness,
      'unlabelled',
      checkpointWorkflow(
        () => ({ capture: [{ scope: 'a', file: 'a.txt' }] }),
        () => ({ to: 'done' }),
        () => {
          throw new Error('no label');
        },
      ),
    );
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    const [saved] = harness.db.select().from(workflowCheckpoints).all();
    assert.equal(saved!.title, 'Save');
    assert.equal(saved!.label, null);
  });
});

test('an invalid plan fails with stage checkpoint_plan and names the problem', async () => {
  await withEngine(async (harness) => {
    commitRepository(harness.worktreePath, { 'a.txt': 'a\n' });
    const { run } = await launchAndSettle(
      harness,
      'invalid',
      checkpointWorkflow(
        () => ({ capture: [{ scope: 'up', directory: '../outside' }] }),
        () => ({ to: 'done' }),
      ),
    );
    assert.equal(run.status, 'failed');
    assert.equal(run.error?.stage, 'checkpoint_plan');
    assert.match(run.error?.message ?? '', /relative path inside the checkout/);
  });
});

test('a scope that passes through a symlink fails instead of copying outside the checkout', async () => {
  await withEngine(async (harness) => {
    commitRepository(harness.worktreePath, { 'a.txt': 'a\n' });
    const outside = mkdtempSync(join(tmpdir(), 'isagi-outside-'));
    try {
      write(outside, 'secret.txt', 's\n');
      symlinkSync(outside, join(harness.worktreePath, 'linked'));
      const { run } = await launchAndSettle(
        harness,
        'linked',
        checkpointWorkflow(
          () => ({ capture: [{ scope: 'secret', file: 'linked/secret.txt' }] }),
          () => ({ to: 'done' }),
        ),
      );
      assert.equal(run.status, 'failed');
      assert.equal(run.error?.stage, 'checkpoint_capture');
      assert.match(run.error?.message ?? '', /symbolic link/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

const graceMs = 60 * 60_000;

/** A sweep of the harness's content store two grace periods ahead, so only liveness keeps a blob. */
function sweepContent(harness: EngineHarness, mark: () => ReadonlySet<string> = () => new Set()) {
  return harness.contentStore.collectGarbage({
    nowMs: Date.now() + 2 * graceMs,
    minAgeMs: graceMs,
    referencedHashes: mark,
  });
}

function sweptStats(result: ContentGcResult | undefined) {
  assert.equal(result?.status, 'swept', `expected a sweep, got ${JSON.stringify(result)}`);
  return (result as Extract<ContentGcResult, { status: 'swept' }>).stats;
}

function blobPath(harness: EngineHarness, hash: string) {
  return contentPathFor(join(dirname(harness.worktreePath), 'workflow-content'), `sha256:${hash}`);
}

test('a capture holds its copies until its checkpoint commits; then the mark keeps them', async () => {
  await withEngine(async (harness) => {
    commitRepository(harness.worktreePath, { 'notes/a.md': 'a\n', 'notes/b.md': 'b\n' });
    let during: ContentGcResult | undefined;
    harness.beforeNextWrite('workflow_save_checkpoint', async () => {
      during = await sweepContent(harness);
    });

    const { run } = await launchAndSettle(
      harness,
      'held',
      checkpointWorkflow(
        () => ({ capture: [{ scope: 'notes', directory: 'notes' }] }),
        () => ({ to: 'done' }),
      ),
    );
    assert.equal(run.status, 'completed', JSON.stringify(run.error));
    const held = sweptStats(during);
    assert.equal(held.kept, 2, 'both copies were held just before the commit');
    assert.deepEqual(held.deleted, []);

    const referenced = listReferencedContentHashes(harness.db);
    assert.equal(referenced.size, 2);
    const paths = [...referenced].map((hash) => blobPath(harness, hash));
    for (const path of paths) assert.equal(existsSync(path), true);

    const marked = sweptStats(
      await sweepContent(harness, () => listReferencedContentHashes(harness.db)),
    );
    assert.equal(marked.kept, 2, 'the committed row keeps them through the mark');

    const released = sweptStats(await sweepContent(harness));
    assert.equal(released.deleted.length, 2, 'after the step nothing holds them');
    for (const path of paths) assert.equal(existsSync(path), false);
  });
});

test('a failed capture holds what it copied until its failure commits', async () => {
  await withEngine(async (harness) => {
    commitRepository(harness.worktreePath, { 'notes/a.md': 'a\n' });
    const outside = mkdtempSync(join(tmpdir(), 'isagi-outside-'));
    try {
      write(outside, 'secret.txt', 's\n');
      symlinkSync(outside, join(harness.worktreePath, 'linked'));
      let during: ContentGcResult | undefined;
      harness.beforeNextWrite('workflow_fail_checkpoint', async () => {
        during = await sweepContent(harness);
      });

      const { run } = await launchAndSettle(
        harness,
        'held-failure',
        checkpointWorkflow(
          () => ({
            capture: [
              { scope: 'notes', directory: 'notes' },
              { scope: 'secret', file: 'linked/secret.txt' },
            ],
          }),
          () => ({ to: 'done' }),
        ),
      );
      assert.equal(run.status, 'failed');
      assert.equal(run.error?.stage, 'checkpoint_capture');
      const held = sweptStats(during);
      assert.equal(held.kept, 1, 'the copy made before the failure was held');
      assert.deepEqual(held.deleted, []);

      const released = sweptStats(await sweepContent(harness));
      assert.equal(released.deleted.length, 1, 'after the failure nothing holds it');
      assert.equal(listReferencedContentHashes(harness.db).size, 0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
