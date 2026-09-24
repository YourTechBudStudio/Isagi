import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Effect, Either } from 'effect';
import Fastify from 'fastify';

import type {
  ListWorkflowCheckpointInventoryOutput,
  ListWorkflowCheckpointManifestOutput,
  WorkflowCheckpointDto,
  WorkflowCheckpointInventoryEntry,
  WorkflowCheckpointManifestEntry,
  WorkflowCheckpointSummaryDto,
} from '@isagi/contracts';

import {
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowRuns,
  workflowSegmentAttempts,
} from '../../persistence/schema.js';
import { registerWorkflowApi } from '../api.js';
import { makeCaptureHarness, type CaptureHarness } from '../checkpoints/capture.test-support.js';
import type { CheckpointEntry } from '../checkpoints/resolve.js';
import { WorkflowEngine } from '../engine/interpreter.service.js';
import { contentPathFor } from '../persistence/content-store.js';
import type { WorkflowCheckpointRecord } from '../persistence/records.js';
import { WorkflowEngineError } from '../types.js';
import { projectExecution } from './project/graph.js';
import {
  makeWorkflowRunProjection,
  WorkflowRunProjection,
  type ReadFailure,
  type WorkflowRunProjectionService,
} from './projection.service.js';

/**
 * The five checkpoint reads, over records a real capture wrote.
 *
 * The public flow — discovery, detail, inventory, bytes — is seeded through the phase-02 capture
 * service against a real repository, so what is read is exactly what capture stores. Paging and
 * warning shapes that capture cannot readily produce (rowless layers, a truncation sentinel,
 * nested frames, a second run) are seeded with `commitCapture`, still against valid run, frame,
 * execution and attempt rows.
 */

const at = '2026-09-23T00:00:00.000Z';
const pin = 'a'.repeat(64);

interface Setup {
  readonly harness: CaptureHarness;
  readonly projection: WorkflowRunProjectionService;
  readonly runId: number;
  readonly rootFrameId: number;
  readonly db: ReturnType<typeof drizzle>;
}

async function withSetup(
  kind: 'git' | 'folder',
  body: (setup: Setup) => Promise<void>,
): Promise<void> {
  const harness = makeCaptureHarness({ kind, label: 'checkpoint-reads' });
  try {
    const db = drizzle(harness.fixture.client);
    const runRow = db.select().from(workflowRuns).get()!;
    const frame = db.select().from(workflowGraphFrames).get()!;
    const projection = makeWorkflowRunProjection(
      harness.fixture.database,
      harness.fixture.payloads,
      harness.fixture.content,
    );
    await body({ harness, projection, runId: runRow.id, rootFrameId: frame.id, db });
  } finally {
    harness.close();
  }
}

function read<A>(effect: Effect.Effect<A, ReadFailure>): Promise<A> {
  return Effect.runPromise(effect);
}

async function rejection(
  effect: Effect.Effect<unknown, ReadFailure>,
): Promise<WorkflowEngineError> {
  const result = await Effect.runPromise(Effect.either(effect));
  assert.ok(Either.isLeft(result), 'expected a rejection');
  assert.ok(result.left instanceof WorkflowEngineError, String(result.left));
  return result.left;
}

async function allInventory(
  projection: WorkflowRunProjectionService,
  runId: number,
  checkpointId: string,
  limit: number,
): Promise<{ entries: WorkflowCheckpointInventoryEntry[]; pages: number }> {
  const entries: WorkflowCheckpointInventoryEntry[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page: ListWorkflowCheckpointInventoryOutput = await read(
      projection.listCheckpointInventory(runId, checkpointId, {
        limit,
        ...(cursor ? { cursor } : {}),
      }),
    );
    assert.equal(page.checkpointId, checkpointId);
    assert.ok(page.entries.length <= limit);
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor);
  return { entries, pages };
}

async function allManifest(
  projection: WorkflowRunProjectionService,
  runId: number,
  checkpointId: string,
  limit: number,
): Promise<{ entries: WorkflowCheckpointManifestEntry[]; pages: number }> {
  const entries: WorkflowCheckpointManifestEntry[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page: ListWorkflowCheckpointManifestOutput = await read(
      projection.listCheckpointManifest(runId, checkpointId, {
        limit,
        ...(cursor ? { cursor } : {}),
      }),
    );
    assert.ok(page.entries.length <= limit);
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor);
  return { entries, pages };
}

/** A visit with its own attempt, in `frameId`, as the engine would have dispatched it. */
function seedVisit(
  setup: Pick<Setup, 'db'>,
  input: {
    readonly runId: number;
    readonly frameId: number;
    readonly nodeId: string;
    readonly nodeKind: 'checkpoint' | 'operation' | 'subgraph';
  },
) {
  const visitIndex = setup.db
    .select()
    .from(workflowNodeExecutions)
    .all()
    .filter((row) => row.frameId === input.frameId && row.nodeId === input.nodeId).length;
  const execution = setup.db
    .insert(workflowNodeExecutions)
    .values({
      runId: input.runId,
      frameId: input.frameId,
      nodeId: input.nodeId,
      nodeKind: input.nodeKind,
      visitIndex,
      status: 'running',
      startedAt: at,
      endCertainty: 'unknown',
    })
    .returning()
    .get();
  const attempt = setup.db
    .insert(workflowSegmentAttempts)
    .values({
      runId: input.runId,
      frameId: input.frameId,
      executionId: execution.id,
      segmentKind: 'node_callback',
      attemptIndex: 0,
      artifactHash: pin,
      status: 'running',
      invocationKind: 'initial',
      startedAt: at,
      endCertainty: 'unknown',
    })
    .returning()
    .get();
  return { executionId: execution.id, attemptId: attempt.id };
}

/** A child frame beneath `parentExecutionId`, which becomes a subgraph visit. */
function seedChildFrame(setup: Pick<Setup, 'db'>, runId: number, parentExecutionId: number) {
  const frame = setup.db
    .insert(workflowGraphFrames)
    .values({
      runId,
      graphKey: 'nested',
      parentExecutionId,
      entryArtifactHash: pin,
      depth: 1,
      status: 'active',
      enteredAt: at,
    })
    .returning()
    .get();
  setup.db
    .update(workflowNodeExecutions)
    .set({ childFrameId: frame.id })
    .where(eq(workflowNodeExecutions.id, parentExecutionId))
    .run();
  return frame.id;
}

/** A second run with its own root frame, to prove every read is run-scoped. */
function seedOtherRun(setup: Pick<Setup, 'db'>) {
  const other = setup.db
    .insert(workflowRuns)
    .values({
      workflowKey: 'fixture',
      title: 'Other run',
      rootGraphKey: 'root',
      artifactHash: pin,
      status: 'running',
      positionJson: JSON.stringify({ kind: 'graph_entry', frameId: 1 }),
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  const frame = setup.db
    .insert(workflowGraphFrames)
    .values({
      runId: other.id,
      graphKey: 'root',
      entryArtifactHash: pin,
      depth: 0,
      status: 'active',
      enteredAt: at,
    })
    .returning()
    .get();
  return { runId: other.id, frameId: frame.id };
}

const blobRef = `sha256:${'d'.repeat(64)}`;

function counts(entries: readonly CheckpointEntry[]) {
  const count = (kind: CheckpointEntry['kind']) =>
    entries.filter((entry) => entry.kind === kind).length;
  return {
    scopes: count('scope'),
    files: count('file'),
    absences: count('absent'),
    warnings: count('warning'),
  };
}

/** A checkpoint written straight through the repository, for shapes capture does not readily make. */
async function commitRows(
  setup: Pick<Setup, 'harness' | 'db'>,
  input: {
    readonly runId: number;
    readonly frameId: number;
    readonly nodeId?: string;
    readonly parent: WorkflowCheckpointRecord | null;
    readonly title: string;
    readonly entries: (key: string) => readonly CheckpointEntry[];
  },
): Promise<WorkflowCheckpointRecord> {
  const nodeId = input.nodeId ?? 'seeded';
  const visit = seedVisit(setup, {
    runId: input.runId,
    frameId: input.frameId,
    nodeId,
    nodeKind: 'checkpoint',
  });
  const checkpointKey = `wcp_${randomUUID()}`;
  const entries = input.entries(checkpointKey);
  return Effect.runPromise(
    setup.harness.repository.commitCapture({
      runId: input.runId,
      frameId: input.frameId,
      ...visit,
      artifactHash: pin,
      nodeId,
      checkpointKey,
      parentCheckpointId: input.parent?.id ?? null,
      title: input.title,
      base: { kind: 'none', reason: 'folder_project' },
      repositoryProjectId: setup.harness.projectId,
      repositoryRootPath: setup.harness.repo,
      entries,
      counts: counts(entries),
      now: at,
    }),
  );
}

// ---------------------------------------------------------------------------
// The public flow over real captures
// ---------------------------------------------------------------------------

test('a client navigates from discovery to verified bytes using only public ids and links', async () => {
  await withSetup('git', async ({ harness, projection, runId }) => {
    harness.write('docs/a.md', 'alpha');
    harness.write('docs/b.md', 'beta');
    harness.write('tools/run.sh', '#!/bin/sh\n', true);
    const head = harness.commitAll('base');
    harness.write('docs/a.md', 'alpha changed');
    harness.write('docs/c.md', 'gamma');
    harness.write('scratch.txt', 'outside every scope');
    const first = await harness.captureOk([{ scope: 'docs', directory: 'docs' }]);

    const listed = await read(projection.listCheckpoints(runId, {}));
    assert.equal(listed.nextCursor, null);
    assert.deepEqual(
      listed.items.map((item) => item.checkpointId),
      [first.checkpointKey],
    );
    const summary: WorkflowCheckpointSummaryDto = listed.items[0]!;
    assert.deepEqual(summary.base, {
      kind: 'git',
      repositoryId: harness.projectId,
      commitSha: head,
    });
    assert.equal(summary.executionId, first.executionId);

    const { checkpoint } = await read(projection.getCheckpoint(runId, summary.checkpointId));
    assert.equal(checkpoint.parentCheckpointId, null);
    // Summarized at commit and served as stored: every Git capture notes that ignored paths were
    // not surveyed, and the untracked `scratch.txt` lies outside the captured scope.
    assert.deepEqual(checkpoint.warningGroups, first.warningGroups);
    assert.deepEqual(checkpoint.warningGroups, [
      { reason: 'uncaptured_dirty_path', count: 1, samples: ['scratch.txt'] },
      { reason: 'ignored_paths_not_surveyed', count: 1, samples: [] },
    ]);
    assert.deepEqual(checkpoint.counts, first.counts);
    assert.equal(checkpoint.provenance.repositoryRootPath, harness.repo);
    assert.equal(
      checkpoint.links.inventory,
      `/api/v1/workflows/runs/${runId}/checkpoints/${first.checkpointKey}/inventory`,
    );
    assert.equal(
      checkpoint.links.manifest,
      `/api/v1/workflows/runs/${runId}/checkpoints/${first.checkpointKey}/manifest`,
    );

    const { entries, pages } = await allInventory(projection, runId, checkpoint.checkpointId, 2);
    assert.ok(pages > 1, 'the inventory needed a continuation');
    const stored = harness.entries(first.id).filter((entry) => entry.kind !== 'change');
    assert.equal(entries.length, stored.length);
    const files = entries.filter((entry) => entry.kind === 'file');
    assert.deepEqual(
      files.map((file) => file.path),
      ['docs/a.md', 'docs/b.md', 'docs/c.md'],
    );
    assert.equal(entries.filter((entry) => entry.kind === 'scope').length, 1);

    const changed = files.find((file) => file.path === 'docs/a.md')!;
    const opened = await read(
      projection.openCheckpointFileContent(runId, checkpoint.checkpointId, changed.fileId),
    );
    assert.equal(opened.mediaType, 'application/octet-stream');
    assert.equal(opened.byteSize, changed.sizeBytes);
    assert.equal(opened.filename, 'a.md');
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'alpha changed');
  });
});

test('a later capture leaves every earlier page, detail and lineage exactly as it was', async () => {
  await withSetup('git', async ({ harness, projection, runId }) => {
    harness.write('docs/a.md', 'alpha');
    harness.commitAll('base');
    harness.write('docs/b.md', 'beta');
    const first = await harness.captureOk([{ scope: 'docs', directory: 'docs' }]);
    const before = {
      inventory: await allInventory(projection, runId, first.checkpointKey, 1),
      detail: await read(projection.getCheckpoint(runId, first.checkpointKey)),
      manifest: await allManifest(projection, runId, first.checkpointKey, 500),
    };

    harness.write('docs/b.md', 'beta, later');
    harness.write('notes.md', 'notes');
    const second = await harness.captureOk([{ scope: 'notes', file: 'notes.md' }]);

    assert.deepEqual(
      await allInventory(projection, runId, first.checkpointKey, 1),
      before.inventory,
    );
    assert.deepEqual(
      await read(projection.getCheckpoint(runId, first.checkpointKey)),
      before.detail,
    );
    assert.deepEqual(
      await allManifest(projection, runId, first.checkpointKey, 500),
      before.manifest,
    );

    // The later checkpoint's own inventory is already resolved: the inherited docs scope and its
    // files are there without a client replaying the first layer.
    const { checkpoint } = await read(projection.getCheckpoint(runId, second.checkpointKey));
    assert.equal(checkpoint.parentCheckpointId, first.checkpointKey);
    const { entries } = await allInventory(projection, runId, second.checkpointKey, 500);
    const scopes = entries.filter((entry) => entry.kind === 'scope');
    assert.deepEqual(
      scopes.map((scope) => [scope.scopeId, scope.capturedBy]),
      [
        ['docs', first.checkpointKey],
        ['notes', second.checkpointKey],
      ],
    );
    const files = entries.filter((entry) => entry.kind === 'file').map((file) => file.path);
    assert.deepEqual(files, ['docs/a.md', 'docs/b.md', 'notes.md']);

    const listed = await read(projection.listCheckpoints(runId, { limit: 1 }));
    assert.deepEqual(
      listed.items.map((item) => item.checkpointId),
      [first.checkpointKey],
    );
    const next = await read(
      projection.listCheckpoints(runId, { limit: 1, cursor: listed.nextCursor! }),
    );
    assert.deepEqual(
      next.items.map((item) => item.checkpointId),
      [second.checkpointKey],
    );
    assert.equal(next.nextCursor, null);
  });
});

test('missing and tampered bytes are unavailable with the checkpoint and file named', async () => {
  await withSetup('folder', async ({ harness, projection, runId }) => {
    harness.write('out/a.txt', 'first');
    harness.write('out/b.txt', 'second');
    const saved = await harness.captureOk([{ scope: 'out', directory: 'out' }]);
    const files = harness.entries(saved.id).filter((entry) => entry.kind === 'file');
    const [a, b] = files;
    assert.ok(a && b && a.kind === 'file' && b.kind === 'file');

    await rm(contentPathFor(harness.fixture.contentRoot, a.contentRef));
    const missing = await rejection(
      projection.openCheckpointFileContent(runId, saved.checkpointKey, a.fileKey),
    );
    assert.equal(missing.code, 'workflow_checkpoint_content_unavailable');
    assert.equal(missing.checkpointId, saved.checkpointKey);
    assert.equal(missing.fileId, a.fileKey);
    assert.equal(missing.payloadCause, 'missing');

    const path = contentPathFor(harness.fixture.contentRoot, b.contentRef);
    await rm(path, { force: true });
    await writeFile(path, 'tampered');
    const corrupt = await rejection(
      projection.openCheckpointFileContent(runId, saved.checkpointKey, b.fileKey),
    );
    assert.equal(corrupt.code, 'workflow_checkpoint_content_unavailable');
    assert.equal(corrupt.fileId, b.fileKey);
    assert.equal(corrupt.payloadCause, 'corrupt');

    // Metadata stays readable; unavailability is learned only at fetch.
    const { entries } = await allInventory(projection, runId, saved.checkpointKey, 500);
    assert.equal(entries.filter((entry) => entry.kind === 'file').length, 2);
  });
});

// ---------------------------------------------------------------------------
// Discovery and identity
// ---------------------------------------------------------------------------

test('discovery filters to one visit or to the checkpoints beneath its child frames', async () => {
  await withSetup('folder', async (setup) => {
    const { projection, runId, rootFrameId } = setup;
    const top = await commitRows(setup, {
      runId,
      frameId: rootFrameId,
      nodeId: 'top',
      parent: null,
      title: 'Top',
      entries: () => [],
    });
    const subgraph = seedVisit(setup, {
      runId,
      frameId: rootFrameId,
      nodeId: 'finalize',
      nodeKind: 'subgraph',
    });
    const childFrameId = seedChildFrame(setup, runId, subgraph.executionId);
    const nested = await commitRows(setup, {
      runId,
      frameId: childFrameId,
      nodeId: 'seal',
      parent: top,
      title: 'Sealed',
      entries: () => [],
    });

    const keys = (items: readonly WorkflowCheckpointSummaryDto[]) =>
      items.map((item) => item.checkpointId);
    assert.deepEqual(keys((await read(projection.listCheckpoints(runId, {}))).items), [
      top.checkpointKey,
      nested.checkpointKey,
    ]);
    assert.deepEqual(
      keys((await read(projection.listCheckpoints(runId, { executionId: top.executionId }))).items),
      [top.checkpointKey],
    );
    // The subgraph visit saved nothing itself; its subtree did.
    assert.deepEqual(
      keys(
        (await read(projection.listCheckpoints(runId, { executionId: subgraph.executionId })))
          .items,
      ),
      [],
    );
    assert.deepEqual(
      keys(
        (
          await read(
            projection.listCheckpoints(runId, {
              executionId: subgraph.executionId,
              descendants: 'true',
            }),
          )
        ).items,
      ),
      [nested.checkpointKey],
    );
    assert.equal(
      (await read(projection.getCheckpoint(runId, nested.checkpointKey))).checkpoint.frameId,
      childFrameId,
    );

    // A continuation is bound to its filters.
    const filtered = await read(
      projection.listCheckpoints(runId, {
        executionId: subgraph.executionId,
        descendants: true,
        limit: 1,
      }),
    );
    assert.equal(filtered.nextCursor, null);
    const whole = await read(projection.listCheckpoints(runId, { limit: 1 }));
    const refused = await rejection(
      projection.listCheckpoints(runId, {
        executionId: subgraph.executionId,
        descendants: true,
        cursor: whole.nextCursor!,
      }),
    );
    assert.equal(refused.code, 'workflow_cursor_invalid');
  });
});

test('every read is scoped to its run, and a file must belong to the named checkpoint', async () => {
  await withSetup('folder', async (setup) => {
    const { harness, projection, runId, rootFrameId } = setup;
    harness.write('out/a.txt', 'first');
    const mine = await harness.captureOk([{ scope: 'out', directory: 'out' }]);
    const mineFile = harness.entries(mine.id).find((entry) => entry.kind === 'file');
    assert.ok(mineFile?.kind === 'file');

    const other = seedOtherRun(setup);
    const theirs = await commitRows(setup, {
      ...other,
      parent: null,
      title: 'Theirs',
      entries: (key) => [
        {
          kind: 'scope',
          scopeId: 'x',
          scopeKind: 'file',
          path: 'x.txt',
          exclusions: [],
          capturedBy: key,
        },
        {
          kind: 'file',
          path: 'x.txt',
          contentRef: mineFile.contentRef,
          byteSize: 5,
          executable: false,
        },
      ],
    });
    const theirFile = harness.entries(theirs.id).find((entry) => entry.kind === 'file');
    assert.ok(theirFile?.kind === 'file');

    for (const effect of [
      projection.getCheckpoint(runId, theirs.checkpointKey),
      projection.listCheckpointInventory(runId, theirs.checkpointKey, {}),
      projection.listCheckpointManifest(runId, theirs.checkpointKey, {}),
      projection.openCheckpointFileContent(runId, theirs.checkpointKey, theirFile.fileKey),
    ]) {
      const refused = await rejection(effect);
      assert.equal(refused.code, 'workflow_checkpoint_not_found');
      assert.equal(refused.checkpointId, theirs.checkpointKey);
    }

    const foreignFile = await rejection(
      projection.openCheckpointFileContent(runId, mine.checkpointKey, theirFile.fileKey),
    );
    assert.equal(foreignFile.code, 'workflow_checkpoint_file_not_found');
    assert.equal(foreignFile.checkpointId, mine.checkpointKey);
    assert.equal(foreignFile.fileId, theirFile.fileKey);

    assert.deepEqual(
      (await read(projection.listCheckpoints(other.runId, {}))).items.map((i) => i.checkpointId),
      [theirs.checkpointKey],
    );
    assert.equal(
      (await rejection(projection.listCheckpoints(9999, {}))).code,
      'workflow_run_not_found',
    );

    // An inventory cursor is bound to its checkpoint.
    const page = await read(
      projection.listCheckpointInventory(runId, mine.checkpointKey, { limit: 1 }),
    );
    assert.ok(page.nextCursor);
    const second = await commitRows(setup, {
      runId,
      frameId: rootFrameId,
      parent: mine,
      title: 'Second',
      entries: () => [],
    });
    const crossed = await rejection(
      projection.listCheckpointInventory(runId, second.checkpointKey, { cursor: page.nextCursor }),
    );
    assert.equal(crossed.code, 'workflow_cursor_invalid');
  });
});

// ---------------------------------------------------------------------------
// Manifest paging
// ---------------------------------------------------------------------------

test('the manifest pages one stream of layers, never repeating a layer and never dropping a rowless one', async () => {
  await withSetup('folder', async (setup) => {
    const { projection, runId, rootFrameId } = setup;
    const file = (path: string) =>
      ({ kind: 'file', path, contentRef: blobRef, byteSize: 1, executable: false }) as const;

    const first = await commitRows(setup, {
      runId,
      frameId: rootFrameId,
      parent: null,
      title: 'First',
      entries: (key) => [
        {
          kind: 'scope',
          scopeId: 'docs',
          scopeKind: 'directory',
          path: 'docs',
          exclusions: [],
          capturedBy: key,
        },
        file('docs/a.md'),
        file('docs/b.md'),
        {
          kind: 'warning',
          reason: 'symlink_skipped',
          path: 'docs/link',
          scopeId: 'docs',
          detail: null,
          observedBy: key,
        },
        {
          kind: 'change',
          operation: 'add',
          path: 'docs/a.md',
          contentRef: blobRef,
          byteSize: 1,
          executable: false,
        },
        {
          kind: 'change',
          operation: 'add',
          path: 'docs/b.md',
          contentRef: blobRef,
          byteSize: 1,
          executable: false,
        },
        { kind: 'change', operation: 'delete', path: 'docs/old.md' },
      ],
    });
    // Inherits everything and observes nothing of its own: its manifest section is only its layer.
    const rowless = await commitRows(setup, {
      runId,
      frameId: rootFrameId,
      parent: first,
      title: 'Rowless',
      entries: () => [
        {
          kind: 'scope',
          scopeId: 'docs',
          scopeKind: 'directory',
          path: 'docs',
          exclusions: [],
          capturedBy: first.checkpointKey,
        },
        file('docs/a.md'),
        file('docs/b.md'),
        {
          kind: 'warning',
          reason: 'symlink_skipped',
          path: 'docs/link',
          scopeId: 'docs',
          detail: null,
          observedBy: first.checkpointKey,
        },
      ],
    });
    const third = await commitRows(setup, {
      runId,
      frameId: rootFrameId,
      parent: rowless,
      title: 'Third',
      entries: (key) => [
        {
          kind: 'scope',
          scopeId: 'docs',
          scopeKind: 'directory',
          path: 'docs',
          exclusions: [],
          capturedBy: first.checkpointKey,
        },
        {
          kind: 'scope',
          scopeId: 'notes',
          scopeKind: 'file',
          path: 'notes.md',
          exclusions: [],
          capturedBy: key,
        },
        file('docs/a.md'),
        file('docs/b.md'),
        file('notes.md'),
        {
          kind: 'warning',
          reason: 'symlink_skipped',
          path: 'docs/link',
          scopeId: 'docs',
          detail: null,
          observedBy: first.checkpointKey,
        },
        {
          kind: 'warning',
          reason: 'ignored_paths_not_surveyed',
          path: null,
          scopeId: null,
          detail: null,
          observedBy: key,
        },
        {
          kind: 'change',
          operation: 'add',
          path: 'notes.md',
          contentRef: blobRef,
          byteSize: 1,
          executable: true,
        },
      ],
    });
    // A later checkpoint is not in an earlier checkpoint's lineage.
    await commitRows(setup, {
      runId,
      frameId: rootFrameId,
      parent: third,
      title: 'Later',
      entries: () => [],
    });

    const whole = await allManifest(projection, runId, third.checkpointKey, 500);
    assert.equal(whole.pages, 1);
    const shape = whole.entries.map((entry) =>
      entry.kind === 'layer'
        ? `layer:${entry.title}`
        : `${entry.kind}:${entry.checkpointId === first.checkpointKey ? 'first' : entry.checkpointId === third.checkpointKey ? 'third' : 'rowless'}`,
    );
    assert.deepEqual(shape, [
      'layer:First',
      'scope:first',
      'warning:first',
      'change:first',
      'change:first',
      'change:first',
      'layer:Rowless',
      'layer:Third',
      'scope:third',
      'warning:third',
      'change:third',
    ]);
    const layers = whole.entries.filter((entry) => entry.kind === 'layer');
    assert.deepEqual(
      layers.map((layer) => layer.parentCheckpointId),
      [null, first.checkpointKey, rowless.checkpointKey],
    );
    const add = whole.entries.find((entry) => entry.kind === 'change' && entry.path === 'notes.md');
    assert.deepEqual(add, {
      kind: 'change',
      checkpointId: third.checkpointKey,
      operation: 'add',
      path: 'notes.md',
      sha256: 'd'.repeat(64),
      sizeBytes: 1,
      executable: true,
    });
    const deletion = whole.entries.find(
      (entry) => entry.kind === 'change' && entry.operation === 'delete',
    );
    assert.deepEqual(deletion, {
      kind: 'change',
      checkpointId: first.checkpointKey,
      operation: 'delete',
      path: 'docs/old.md',
    });

    // Every page size yields the same stream, including pages that end inside a layer.
    for (const limit of [1, 2, 3, 4]) {
      const paged = await allManifest(projection, runId, third.checkpointKey, limit);
      assert.deepEqual(paged.entries, whole.entries, `limit ${limit}`);
      assert.equal(paged.pages, Math.ceil(whole.entries.length / limit), `limit ${limit}`);
    }

    const earlier = await allManifest(projection, runId, rowless.checkpointKey, 500);
    assert.deepEqual(
      earlier.entries.filter((entry) => entry.kind === 'layer').map((layer) => layer.checkpointId),
      [first.checkpointKey, rowless.checkpointKey],
    );
  });
});

// ---------------------------------------------------------------------------
// Warning groups and the execution summary
// ---------------------------------------------------------------------------

test('warning groups summarize only this layer, in vocabulary order, with folded truncation', async () => {
  await withSetup('folder', async (setup) => {
    const { projection, runId, rootFrameId } = setup;
    const parent = await commitRows(setup, {
      runId,
      frameId: rootFrameId,
      parent: null,
      title: 'Parent',
      entries: () => [],
    });
    const dirty = Array.from({ length: 7 }, (_, index) => `dirty/${index}.txt`);
    const saved = await commitRows(setup, {
      runId,
      frameId: rootFrameId,
      parent,
      title: 'Warned',
      entries: (key) => [
        {
          kind: 'scope',
          scopeId: 'src',
          scopeKind: 'directory',
          path: 'src',
          exclusions: [],
          capturedBy: key,
        },
        // Inherited from the parent: excluded from this layer's groups.
        {
          kind: 'warning',
          reason: 'special_file_skipped',
          path: 'src/fifo',
          scopeId: 'src',
          detail: null,
          observedBy: parent.checkpointKey,
        },
        {
          kind: 'warning',
          reason: 'symlink_skipped',
          path: 'src/inherited-link',
          scopeId: 'src',
          detail: null,
          observedBy: parent.checkpointKey,
        },
        {
          kind: 'warning',
          reason: 'symlink_skipped',
          path: 'src/own-link',
          scopeId: 'src',
          detail: null,
          observedBy: key,
        },
        {
          kind: 'warning',
          reason: 'ignored_paths_not_surveyed',
          path: null,
          scopeId: null,
          detail: null,
          observedBy: key,
        },
        ...dirty.map(
          (path) =>
            ({
              kind: 'warning',
              reason: 'uncaptured_dirty_path',
              path,
              scopeId: null,
              detail: null,
              observedBy: key,
            }) as const,
        ),
        {
          kind: 'warning',
          reason: 'warnings_truncated',
          path: null,
          scopeId: null,
          detail: { omitted: 12 },
          observedBy: key,
        },
      ],
    });

    const { checkpoint }: { checkpoint: WorkflowCheckpointDto } = await read(
      projection.getCheckpoint(runId, saved.checkpointKey),
    );
    assert.deepEqual(checkpoint.warningGroups, [
      { reason: 'uncaptured_dirty_path', count: 19, samples: dirty.slice(0, 5) },
      { reason: 'ignored_paths_not_surveyed', count: 1, samples: [] },
      { reason: 'symlink_skipped', count: 1, samples: ['src/own-link'] },
    ]);
    // Counts describe the resolved set, inherited region warnings included.
    assert.equal(checkpoint.counts.warnings, 12);

    const quiet = await read(projection.getCheckpoint(runId, parent.checkpointKey));
    assert.deepEqual(quiet.checkpoint.warningGroups, []);
  });
});

test('an execution carries its committed checkpoint, and null for anything else', async () => {
  await withSetup('folder', async (setup) => {
    const { harness, runId, rootFrameId } = setup;
    harness.write('out/a.txt', 'first');
    const saved = await harness.captureOk([{ scope: 'out', directory: 'out' }]);
    const pending = seedVisit(setup, {
      runId,
      frameId: rootFrameId,
      nodeId: 'save',
      nodeKind: 'checkpoint',
    });
    const plain = seedVisit(setup, {
      runId,
      frameId: rootFrameId,
      nodeId: 'write',
      nodeKind: 'operation',
    });

    const project = (executionId: number) =>
      Effect.runPromise(
        harness.fixture.database.use('test_project_execution', (db) =>
          projectExecution(db, executionId),
        ),
      );
    assert.deepEqual((await project(saved.executionId))?.checkpoint, {
      checkpointId: saved.checkpointKey,
      title: saved.title,
      base: saved.base,
      counts: saved.counts,
    });
    // Not captured yet, or a capture that failed: no row, so nothing was saved.
    assert.equal((await project(pending.executionId))?.checkpoint, null);
    assert.equal((await project(plain.executionId))?.checkpoint, null);
  });
});

// ---------------------------------------------------------------------------
// HTTP: envelopes, validation and streaming headers
// ---------------------------------------------------------------------------

function serve(projection: WorkflowRunProjectionService) {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(fastify, {
    runPromise: async <A>(effect: Effect.Effect<A, unknown, never>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(WorkflowEngine, {} as never),
          Effect.provideService(WorkflowRunProjection, projection),
        ) as Effect.Effect<A, unknown, never>,
      ),
  } as never);
  return fastify;
}

test('the five routes answer in the standard envelopes, and bytes stream with their headers', async () => {
  await withSetup('folder', async ({ harness, projection, runId }) => {
    harness.write('out/résumé.md', 'hello');
    const saved = await harness.captureOk([{ scope: 'out', directory: 'out' }]);
    const fastify = serve(projection);
    try {
      const base = `/api/v1/workflows/runs/${runId}/checkpoints`;
      const get = (url: string) => fastify.inject({ method: 'GET', url });

      const list = await get(base);
      assert.equal(list.statusCode, 200);
      const listed = JSON.parse(list.body) as {
        data: { items: WorkflowCheckpointSummaryDto[] };
        meta: { requestId: string };
      };
      assert.ok(listed.meta.requestId);
      assert.equal(listed.data.items[0]?.checkpointId, saved.checkpointKey);

      const refused = await get(`${base}?descendants=true`);
      assert.equal(refused.statusCode, 400);
      assert.equal(
        (JSON.parse(refused.body) as { error: { code: string } }).error.code,
        'api_request_decoding_failed',
      );
      assert.equal((await get(`${base}?limit=501`)).statusCode, 400);

      const detail = JSON.parse((await get(`${base}/${saved.checkpointKey}`)).body) as {
        data: { checkpoint: WorkflowCheckpointDto };
      };
      const inventory = JSON.parse((await get(detail.data.checkpoint.links.inventory)).body) as {
        data: ListWorkflowCheckpointInventoryOutput;
      };
      const manifest = await get(detail.data.checkpoint.links.manifest);
      assert.equal(manifest.statusCode, 200);
      const file = inventory.data.entries.find((entry) => entry.kind === 'file');
      assert.ok(file?.kind === 'file');

      const content = await get(`${base}/${saved.checkpointKey}/files/${file.fileId}/content`);
      assert.equal(content.statusCode, 200);
      assert.equal(content.headers['content-type'], 'application/octet-stream');
      assert.equal(content.headers['content-length'], '5');
      assert.equal(content.headers['content-disposition'], undefined);
      assert.equal(content.body, 'hello');

      const download = await get(
        `${base}/${saved.checkpointKey}/files/${file.fileId}/content?download=true`,
      );
      assert.equal(
        download.headers['content-disposition'],
        `attachment; filename="r_sum_.md"; filename*=UTF-8''r%C3%A9sum%C3%A9.md`,
      );

      const missingFile = await get(`${base}/${saved.checkpointKey}/files/wcf_nope/content`);
      assert.equal(missingFile.statusCode, 400);
      assert.deepEqual(
        (JSON.parse(missingFile.body) as { error: { data: Record<string, unknown> } }).error.data,
        {
          reason: 'workflow_checkpoint_file_not_found',
          workflowRunId: runId,
          checkpointId: saved.checkpointKey,
          fileId: 'wcf_nope',
        },
      );

      await rm(contentPathFor(harness.fixture.contentRoot, `sha256:${file.sha256}`));
      const unavailable = await get(`${base}/${saved.checkpointKey}/files/${file.fileId}/content`);
      assert.equal(unavailable.statusCode, 400);
      assert.deepEqual(
        (JSON.parse(unavailable.body) as { error: { data: Record<string, unknown> } }).error.data,
        {
          reason: 'workflow_checkpoint_content_unavailable',
          checkpointId: saved.checkpointKey,
          fileId: file.fileId,
          cause: 'missing',
          workflowRunId: runId,
        },
      );

      const unknown = await get(`${base}/wcp_nope`);
      assert.equal(unknown.statusCode, 400);
      assert.equal(
        (JSON.parse(unknown.body) as { error: { data: { reason: string } } }).error.data.reason,
        'workflow_checkpoint_not_found',
      );
    } finally {
      await fastify.close();
    }
  });
});
