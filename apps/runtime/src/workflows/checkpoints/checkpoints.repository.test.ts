import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Effect, Exit } from 'effect';

import {
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowRuns,
  workflowSegmentAttempts,
} from '../../persistence/schema.js';
import {
  makeWorkflowPersistenceFixture,
  run,
  type WorkflowPersistenceFixture,
} from '../persistence/test-support.js';
import {
  makeWorkflowCheckpointRepository,
  type CommitCheckpointInput,
  type WorkflowCheckpointRepositoryService,
} from './checkpoints.repository.js';
import type { NormalizedScope } from './plan.js';
import { applyRegions, finishFold, type ParentResolvedState } from './resolve.js';
import type { CanonicalBaseEntry, CollectedFile, CollectedRegion } from './types.js';

const artifactHash = 'a'.repeat(64);
const at = '2026-09-23T00:00:00.000Z';
const sha = 'c'.repeat(40);

const ref = (tag: string) => `sha256:${tag.padEnd(64, '0')}`;
const file = (path: string, tag: string): CollectedFile => ({
  path,
  contentRef: ref(tag),
  byteSize: tag.length,
  executable: false,
  objectId: `oid-${tag}`,
});
const dir = (scopeId: string, path: string, exclusions: string[] = []): NormalizedScope => ({
  scopeId,
  kind: 'directory',
  path,
  exclusions,
});
const collected = (scope: NormalizedScope, files: CollectedFile[]): CollectedRegion => ({
  scope,
  absoluteRoot: `/wt/${scope.path}`,
  files,
  warnings: [],
});

let fixture: WorkflowPersistenceFixture;
let repository: WorkflowCheckpointRepositoryService;

beforeEach(() => {
  fixture = makeWorkflowPersistenceFixture();
  fixture.seedArtifact(artifactHash);
  repository = makeWorkflowCheckpointRepository(fixture.database);
});
afterEach(() => fixture.close());

/** A run with one frame; `visit()` adds a checkpoint execution and its claimed attempt. */
function seedRun() {
  const db = drizzle(fixture.client);
  const runRow = db
    .insert(workflowRuns)
    .values({
      workflowKey: 'fixture',
      title: 'Run',
      rootGraphKey: 'root',
      artifactHash,
      status: 'running',
      positionJson: JSON.stringify({ kind: 'graph_entry', frameId: 1 }),
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  const frame = db
    .insert(workflowGraphFrames)
    .values({
      runId: runRow.id,
      graphKey: 'root',
      entryArtifactHash: artifactHash,
      depth: 0,
      status: 'active',
      enteredAt: at,
    })
    .returning()
    .get();
  let visits = 0;
  const visit = () => {
    const execution = db
      .insert(workflowNodeExecutions)
      .values({
        runId: runRow.id,
        frameId: frame.id,
        nodeId: 'save',
        nodeKind: 'checkpoint',
        visitIndex: visits++,
        status: 'running',
        startedAt: at,
        endCertainty: 'unknown',
      })
      .returning()
      .get();
    const attempt = db
      .insert(workflowSegmentAttempts)
      .values({
        runId: runRow.id,
        frameId: frame.id,
        executionId: execution.id,
        segmentKind: 'node_callback',
        attemptIndex: 0,
        artifactHash,
        status: 'running',
        invocationKind: 'initial',
        startedAt: at,
        endCertainty: 'unknown',
      })
      .returning()
      .get();
    return {
      runId: runRow.id,
      frameId: frame.id,
      executionId: execution.id,
      attemptId: attempt.id,
    };
  };
  return { runId: runRow.id, visit };
}

function commitInput(
  placement: { runId: number; frameId: number; executionId: number; attemptId: number },
  layer: {
    key: string;
    parent: { id: number; state: ParentResolvedState } | null;
    regions: CollectedRegion[];
    base?: CanonicalBaseEntry[];
  },
): CommitCheckpointInput {
  const provisional = applyRegions({
    checkpointKey: layer.key,
    parent: layer.parent?.state ?? null,
    regions: layer.regions,
  });
  const folded = finishFold({
    checkpointKey: layer.key,
    provisional,
    base: layer.base ?? [],
    survey: { ok: true, entries: [] },
    isGitProject: true,
  });
  return {
    ...placement,
    artifactHash,
    nodeId: 'save',
    checkpointKey: layer.key,
    parentCheckpointId: layer.parent?.id ?? null,
    title: `Layer ${layer.key}`,
    base: { kind: 'git', repositoryId: 7, commitSha: sha },
    repositoryProjectId: 7,
    repositoryRootPath: '/repo',
    entries: folded.entries,
    counts: folded.counts,
    now: at,
  };
}

const count = (table: string) =>
  (fixture.client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('committing a checkpoint', () => {
  it('writes the row and every entry in seq order, and reads back the state the fold produced', async () => {
    const seeded = seedRun();
    const input = commitInput(seeded.visit(), {
      key: 'wcp_one',
      parent: null,
      regions: [collected(dir('docs', 'docs'), [file('docs/plan.md', 'p')])],
      base: [
        {
          original: 'docs/gone.md',
          authored: 'docs/gone.md',
          objectId: 'oid-g',
          executable: false,
        },
      ],
    });
    const record = await run(repository.commitCapture(input));
    assert.equal(record.checkpointKey, 'wcp_one');
    assert.deepEqual(record.base, { kind: 'git', repositoryId: 7, commitSha: sha });
    assert.deepEqual(record.counts, { scopes: 1, files: 1, absences: 1, warnings: 1 });

    // Trace one resolved file and one required absence from scope to stored rows.
    const rows = fixture.client
      .prepare(
        'SELECT seq, kind, path, file_key, content_ref, scope_id, change_operation FROM workflow_checkpoint_entries ORDER BY seq',
      )
      .all() as Record<string, unknown>[];
    assert.deepEqual(
      rows.map((row) => `${row.seq} ${row.kind} ${row.path ?? '-'}`),
      [
        '0 scope docs',
        '1 absent docs/gone.md',
        '2 file docs/plan.md',
        '3 warning -',
        '4 change docs/gone.md',
        '5 change docs/plan.md',
      ],
    );
    const fileRow = rows.find((row) => row.kind === 'file')!;
    assert.match(String(fileRow.file_key), /^wcf_[0-9a-f-]{36}$/);
    assert.equal(fileRow.content_ref, ref('p'));
    assert.equal(rows.find((row) => row.kind === 'absent')!.file_key, null);

    const state = await run(repository.resolvedStateOf(record.id));
    assert.deepEqual([...state.files.keys()], ['docs/plan.md']);
    assert.deepEqual(state.coverage, [
      { scopeId: 'docs', kind: 'directory', path: 'docs', exclusions: [], capturedBy: 'wcp_one' },
    ]);
    assert.deepEqual(state.regionWarnings, []);
    assert.deepEqual([...state.bindings.keys()], ['docs']);
  });

  it('finds the receipt by execution and the latest checkpoint in the run', async () => {
    const seeded = seedRun();
    const first = seeded.visit();
    assert.equal(await run(repository.findLatestInRun(seeded.runId)), null);
    assert.equal(await run(repository.findByExecution(first.executionId)), null);
    const one = await run(
      repository.commitCapture(commitInput(first, { key: 'wcp_one', parent: null, regions: [] })),
    );
    const two = await run(
      repository.commitCapture(
        commitInput(seeded.visit(), {
          key: 'wcp_two',
          parent: { id: one.id, state: await run(repository.resolvedStateOf(one.id)) },
          regions: [],
        }),
      ),
    );
    assert.equal(
      (await run(repository.findByExecution(first.executionId)))?.checkpointKey,
      'wcp_one',
    );
    assert.equal((await run(repository.findLatestInRun(seeded.runId)))?.id, two.id);
    assert.equal(two.parentCheckpointId, one.id);
  });

  it('refuses a second checkpoint for one execution and leaves no partial rows', async () => {
    const seeded = seedRun();
    const placement = seeded.visit();
    await run(
      repository.commitCapture(
        commitInput(placement, {
          key: 'wcp_one',
          parent: null,
          regions: [collected(dir('docs', 'docs'), [file('docs/a.md', 'a')])],
        }),
      ),
    );
    const entriesBefore = count('workflow_checkpoint_entries');
    const again = await Effect.runPromiseExit(
      repository.commitCapture(
        commitInput(placement, {
          key: 'wcp_again',
          parent: null,
          regions: [collected(dir('docs', 'docs'), [file('docs/a.md', 'a')])],
        }),
      ),
    );
    assert.ok(Exit.isFailure(again));
    assert.equal(count('workflow_checkpoints'), 1);
    assert.equal(count('workflow_checkpoint_entries'), entriesBefore);
  });

  it('rolls back the whole capture when an entry is invalid', async () => {
    const seeded = seedRun();
    const input = commitInput(seeded.visit(), {
      key: 'wcp_bad',
      parent: null,
      regions: [collected(dir('docs', 'docs'), [file('docs/a.md', 'a')])],
    });
    const broken: CommitCheckpointInput = {
      ...input,
      entries: [...input.entries, { kind: 'absent', path: '' }],
      counts: { ...input.counts, absences: input.counts.absences + 1 },
    };
    const exit = await Effect.runPromiseExit(repository.commitCapture(broken));
    assert.ok(Exit.isFailure(exit));
    const mismatched = await Effect.runPromiseExit(
      repository.commitCapture({ ...input, counts: { ...input.counts, files: 9 } }),
    );
    assert.ok(Exit.isFailure(mismatched));
    assert.equal(count('workflow_checkpoints'), 0);
    assert.equal(count('workflow_checkpoint_entries'), 0);
  });

  it('keeps a scope binding after another scope supersedes its region', async () => {
    const seeded = seedRun();
    const one = await run(
      repository.commitCapture(
        commitInput(seeded.visit(), {
          key: 'wcp_one',
          parent: null,
          regions: [collected(dir('app', 'src/app'), [file('src/app/x.ts', 'x')])],
        }),
      ),
    );
    const two = await run(
      repository.commitCapture(
        commitInput(seeded.visit(), {
          key: 'wcp_two',
          parent: { id: one.id, state: await run(repository.resolvedStateOf(one.id)) },
          regions: [collected(dir('src', 'src', ['gen']), [file('src/app/x.ts', 'x')])],
        }),
      ),
    );
    const state = await run(repository.resolvedStateOf(two.id));
    assert.deepEqual(
      state.coverage.map((region) => region.scopeId),
      ['src'],
    );
    assert.deepEqual(state.bindings.get('app'), {
      scopeId: 'app',
      kind: 'directory',
      path: 'src/app',
      exclusions: [],
    });
    assert.deepEqual(state.bindings.get('src')?.exclusions, ['gen']);
  });

  it('reads back inherited region warnings but never layer warnings', async () => {
    const seeded = seedRun();
    const one = await run(
      repository.commitCapture(
        commitInput(seeded.visit(), {
          key: 'wcp_one',
          parent: null,
          regions: [
            {
              scope: dir('docs', 'docs'),
              absoluteRoot: '/wt/docs',
              files: [],
              warnings: [{ reason: 'symlink_skipped', path: 'docs/link', scopeId: 'docs' }],
            },
          ],
        }),
      ),
    );
    const state = await run(repository.resolvedStateOf(one.id));
    assert.deepEqual(state.regionWarnings, [
      {
        reason: 'symlink_skipped',
        path: 'docs/link',
        scopeId: 'docs',
        detail: null,
        observedBy: 'wcp_one',
      },
    ]);
  });
});

describe('the database enforces the checkpoint row invariants', () => {
  const insertCheckpoint = (overrides: Record<string, unknown>) => {
    const seeded = seedRun();
    const placement = seeded.visit();
    const values = {
      checkpoint_key: `wcp_${Math.random()}`,
      run_id: placement.runId,
      frame_id: placement.frameId,
      execution_id: placement.executionId,
      attempt_id: placement.attemptId,
      artifact_hash: artifactHash,
      parent_checkpoint_id: null,
      node_id: 'save',
      title: 'T',
      base_kind: 'git',
      base_reason: null,
      base_commit_sha: sha,
      repository_project_id: 999,
      repository_root_path: '/nowhere',
      scope_count: 0,
      file_count: 0,
      absent_count: 0,
      warning_count: 0,
      created_at: at,
      ...overrides,
    };
    const columns = Object.keys(values);
    return fixture.client
      .prepare(
        `INSERT INTO workflow_checkpoints (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
      )
      .run(values).lastInsertRowid;
  };

  it('requires the base columns to agree with the base kind', () => {
    // No project foreign key: history outlives the project it was captured from.
    assert.ok(insertCheckpoint({}));
    assert.ok(
      insertCheckpoint({ base_kind: 'none', base_commit_sha: null, base_reason: 'folder_project' }),
    );
    for (const broken of [
      { base_commit_sha: null },
      { base_reason: 'folder_project' },
      { base_kind: 'none' },
      { base_kind: 'none', base_commit_sha: null },
    ]) {
      assert.throws(
        () => insertCheckpoint(broken),
        /CHECK constraint failed/,
        JSON.stringify(broken),
      );
    }
  });

  it('requires each entry kind to carry its columns, and file keys only on files', () => {
    const checkpointId = insertCheckpoint({});
    let seq = 0;
    const insertEntry = (values: Record<string, unknown>) => {
      const row = { checkpoint_id: checkpointId, seq: seq++, ...values };
      const columns = Object.keys(row);
      fixture.client
        .prepare(
          `INSERT INTO workflow_checkpoint_entries (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
        )
        .run(row);
    };
    const valid = {
      scope: {
        kind: 'scope',
        path: 'd',
        scope_id: 's',
        scope_kind: 'directory',
        exclusions_json: '[]',
        captured_by_checkpoint_key: 'k',
      },
      file: {
        kind: 'file',
        path: 'd/f',
        file_key: 'wcf_1',
        content_ref: ref('f'),
        byte_size: 1,
        executable: 0,
      },
      absent: { kind: 'absent', path: 'd/g' },
      warning: {
        kind: 'warning',
        warning_reason: 'ignored_paths_not_surveyed',
        observed_by_checkpoint_key: 'k',
      },
      delete: { kind: 'change', path: 'd/g', change_operation: 'delete' },
      add: {
        kind: 'change',
        path: 'd/f',
        change_operation: 'add',
        content_ref: ref('f'),
        byte_size: 1,
        executable: 0,
      },
    };
    for (const row of Object.values(valid)) insertEntry(row);
    for (const broken of [
      { ...valid.scope, captured_by_checkpoint_key: null },
      { ...valid.file, file_key: null },
      { ...valid.file, file_key: 'wcf_2', executable: null },
      { ...valid.absent, path: null },
      { ...valid.warning, observed_by_checkpoint_key: null },
      { ...valid.add, content_ref: null },
      { ...valid.delete, change_operation: null },
      { ...valid.absent, file_key: 'wcf_3' },
    ]) {
      assert.throws(() => insertEntry(broken), /CHECK constraint failed/, JSON.stringify(broken));
    }
  });
});

describe('retention and deletion', () => {
  it('lists distinct content references per checkpoint for later project deletion', async () => {
    const seeded = seedRun();
    const one = await run(
      repository.commitCapture(
        commitInput(seeded.visit(), {
          key: 'wcp_one',
          parent: null,
          regions: [
            collected(dir('docs', 'docs'), [file('docs/a.md', 'a'), file('docs/b.md', 'a')]),
          ],
        }),
      ),
    );
    await run(
      repository.commitCapture(
        commitInput(seeded.visit(), {
          key: 'wcp_two',
          parent: { id: one.id, state: await run(repository.resolvedStateOf(one.id)) },
          regions: [collected(dir('docs', 'docs'), [file('docs/a.md', 'z')])],
        }),
      ),
    );
    assert.deepEqual(await run(repository.listRetentionForRuns([seeded.runId])), [
      { checkpointKey: 'wcp_one', repositoryProjectId: 7, contentRefs: [ref('a')] },
      { checkpointKey: 'wcp_two', repositoryProjectId: 7, contentRefs: [ref('z')] },
    ]);
    assert.deepEqual(await run(repository.listRetentionForRuns([])), []);
    assert.deepEqual(await run(repository.listRetentionForRuns([seeded.runId + 100])), []);
  });

  it('deleting the run removes a whole parent/child lineage and its entries in one statement', async () => {
    const seeded = seedRun();
    const one = await run(
      repository.commitCapture(
        commitInput(seeded.visit(), {
          key: 'wcp_one',
          parent: null,
          regions: [collected(dir('docs', 'docs'), [file('docs/a.md', 'a')])],
        }),
      ),
    );
    await run(
      repository.commitCapture(
        commitInput(seeded.visit(), {
          key: 'wcp_two',
          parent: { id: one.id, state: await run(repository.resolvedStateOf(one.id)) },
          regions: [],
        }),
      ),
    );
    fixture.client.prepare('DELETE FROM workflow_runs WHERE id = ?').run(seeded.runId);
    assert.equal(count('workflow_checkpoints'), 0);
    assert.equal(count('workflow_checkpoint_entries'), 0);
    assert.deepEqual(fixture.client.pragma('foreign_key_check'), []);
  });
});
