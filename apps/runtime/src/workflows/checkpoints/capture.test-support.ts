/**
 * A real destination for checkpoint capture tests: a Git repository (or plain folder) registered as
 * a project with a worktree row, a migrated database, a real content store, and one run whose
 * visits each get their own execution and attempt.
 *
 * Also reconstruction through the production path: `exportCheckpoint` serves the real workflow and
 * workspace routes on a loopback port, over the real read projection and a real workspace service
 * sharing this fixture's database, and runs the CLI's `checkpoints export` module against them. So
 * there is exactly one implementation of applying a checkpoint, and these tests exercise it.
 */

import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Effect, Exit, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import { exportCheckpoint, runtimeApiLayer, type ExportResult } from '@isagi/cli/export';
import type {
  ListWorkflowCheckpointInventoryOutput,
  WorkflowCheckpointInventoryEntry,
} from '@isagi/contracts';

import { Git, GitLive, type GitService } from '../../git/git.command.js';
import { createFixtureWorkspace, type FixtureWorkspace } from '../../git/tests/fixtures.js';
import type { DatabaseError } from '../../persistence/index.js';
import {
  workflowCheckpointEntries,
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowRunPreparations,
  workflowRuns,
  workflowSegmentAttempts,
} from '../../persistence/schema.js';
import { registerWorkspaceApi } from '../../workspace/api.js';
import { liveWorkspaceLayer } from '../../workspace/tests/live-workspace-support.js';
import { WorkspaceService } from '../../workspace/workspace.service.js';
import { registerWorkflowApi } from '../api.js';
import { WorkflowEngine } from '../engine/interpreter.service.js';
import { nodeDirectoryReader, type DirectoryReader, type EntryStat } from '../paths.js';
import type {
  WorkflowCheckpointEntryRecord,
  WorkflowCheckpointRecord,
} from '../persistence/records.js';
import { checkpointEntryRecord } from '../persistence/row-mappers.js';
import {
  makeWorkflowPersistenceFixture,
  type WorkflowPersistenceFixture,
} from '../persistence/test-support.js';
import { captureTransitionChanges } from '../read/capture.js';
import { makeWorkflowRunProjection, WorkflowRunProjection } from '../read/projection.service.js';
import {
  makeWorkflowCheckpointCapture,
  type CheckpointCaptureFailure,
  type WorkflowCheckpointCaptureDependencies,
} from './capture.service.js';
import {
  makeWorkflowCheckpointRepository,
  type WorkflowCheckpointRepositoryService,
} from './checkpoints.repository.js';
import { normalizeCheckpointPlan } from './plan.js';

export const liveGit: GitService = Effect.runSync(Git.pipe(Effect.provide(GitLive)));

const artifactHash = 'a'.repeat(64);
const at = '2026-09-23T00:00:00.000Z';

export type CaptureOverrides = Partial<
  Pick<WorkflowCheckpointCaptureDependencies, 'git' | 'content' | 'checkpoints' | 'directoryReader'>
>;

export interface TreeFile {
  readonly content: string;
  readonly executable: boolean;
}

export interface CaptureHarness {
  readonly fixture: WorkflowPersistenceFixture;
  readonly workspace: FixtureWorkspace;
  /** The destination worktree directory. */
  readonly repo: string;
  readonly repository: WorkflowCheckpointRepositoryService;
  readonly worktreeId: number;
  readonly projectId: number;
  /** Fixture-isolated `git` in the destination. Never used by code under test. */
  readonly git: (args: readonly string[]) => string;
  readonly write: (path: string, content: string, executable?: boolean) => void;
  readonly remove: (path: string) => void;
  /** Stage everything and commit, returning the new HEAD. */
  readonly commitAll: (message: string) => string;
  readonly capture: (
    scopes: readonly Record<string, unknown>[],
    overrides?: CaptureOverrides,
  ) => Promise<Exit.Exit<WorkflowCheckpointRecord, CheckpointCaptureFailure | DatabaseError>>;
  readonly captureOk: (
    scopes: readonly Record<string, unknown>[],
    overrides?: CaptureOverrides,
  ) => Promise<WorkflowCheckpointRecord>;
  /** The refusal's reason; fails the test on success or a fault. */
  readonly refusal: (
    scopes: readonly Record<string, unknown>[],
    overrides?: CaptureOverrides,
  ) => Promise<CheckpointCaptureFailure>;
  readonly entries: (checkpointId: number) => WorkflowCheckpointEntryRecord[];
  readonly checkpointCount: () => number;
  /**
   * Exports the checkpoint with the production `checkpoints export` module, over the real routes
   * and the real workspace service. `destination` defaults to a fresh path beside the repository,
   * never inside it.
   */
  readonly exportCheckpoint: (
    record: WorkflowCheckpointRecord,
    destination?: string,
  ) => Promise<{ readonly result: ExportResult; readonly destination: string }>;
  /** The checkpoint's resolved inventory, every page, through the public read. */
  readonly inventory: (
    record: WorkflowCheckpointRecord,
  ) => Promise<readonly WorkflowCheckpointInventoryEntry[]>;
  /**
   * Exports and asserts the result is complete with the checkpoint's own base, the worktree a Git
   * base implies (none otherwise) and the limitations for that base; returns the exported root.
   */
  readonly exported: (record: WorkflowCheckpointRecord, destination?: string) => Promise<string>;
  readonly close: () => void;
}

export function makeCaptureHarness(
  options: { readonly kind?: 'git' | 'folder'; readonly label?: string } = {},
): CaptureHarness {
  const kind = options.kind ?? 'git';
  const fixture = makeWorkflowPersistenceFixture();
  fixture.seedArtifact(artifactHash);
  const workspace = createFixtureWorkspace(options.label ?? 'checkpoint-capture');
  const repo = workspace.directory('repo');
  const git = (args: readonly string[]) => workspace.git(repo, args);
  if (kind === 'git') git(['init']);

  const project = fixture.client
    .prepare(
      `INSERT INTO projects (name, root_path, kind, status, sort_order, created_at, updated_at)
       VALUES ('fixture', ?, ?, 'present', 0, ?, ?)`,
    )
    .run(repo, kind, at, at);
  const worktree = fixture.client
    .prepare(
      `INSERT INTO worktrees (project_id, path, branch, head, sort_order, created_at, updated_at, first_seen_at)
       VALUES (?, ?, 'main', NULL, 0, ?, ?, ?)`,
    )
    .run(project.lastInsertRowid, repo, at, at, at);
  const projectId = Number(project.lastInsertRowid);
  const worktreeId = Number(worktree.lastInsertRowid);

  const db = drizzle(fixture.client);
  const runRow = db
    .insert(workflowRuns)
    .values({
      workflowKey: 'fixture',
      title: 'Run',
      rootGraphKey: 'root',
      artifactHash,
      status: 'running',
      // Revision 1: the read model's revisions are positive, and one is published below.
      revision: 1,
      positionJson: JSON.stringify({ kind: 'graph_entry', frameId: 1 }),
      destinationWorktreeId: worktreeId,
      destinationWorktreePath: repo,
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
  // The preparation row `createRun` writes with every run (a default current/current placement),
  // and the run's read-model summary and root frame projected from these rows by the runtime's own
  // writer, so the public run read (which the export's source-containment check uses) answers.
  db.insert(workflowRunPreparations)
    .values({
      runId: runRow.id,
      source: 'default',
      requestJson: JSON.stringify({ worktree: { kind: 'current' }, surface: { kind: 'current' } }),
      createdAt: at,
      updatedAt: at,
    })
    .run();
  Effect.runSync(
    fixture.database.use('fixture_run_summary', (database) =>
      captureTransitionChanges(
        database,
        runRow.id,
        [runRow.revision],
        [{ kind: 'run_started', frameId: frame.id }],
      ),
    ),
  );

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
    return { executionId: execution.id, attemptId: attempt.id };
  };

  const repository = makeWorkflowCheckpointRepository(fixture.database);

  const capture: CaptureHarness['capture'] = (scopes, overrides = {}) => {
    const plan = normalizeCheckpointPlan({ capture: scopes }, { nodeId: 'save' });
    if (!plan.ok) throw new Error(`invalid test plan: ${JSON.stringify(plan)}`);
    const service = makeWorkflowCheckpointCapture({
      git: overrides.git ?? liveGit,
      content: overrides.content ?? fixture.content,
      checkpoints: overrides.checkpoints ?? repository,
      database: fixture.database,
      now: () => at,
      ...(overrides.directoryReader ? { directoryReader: overrides.directoryReader } : {}),
    });
    const placement = visit();
    return Effect.runPromiseExit(
      service.capture({
        runId: runRow.id,
        frameId: frame.id,
        ...placement,
        artifactHash,
        nodeId: 'save',
        worktreeId,
        plan: plan.value,
      }),
    );
  };

  const captureOk: CaptureHarness['captureOk'] = async (scopes, overrides) => {
    const exit = await capture(scopes, overrides);
    if (Exit.isFailure(exit)) throw new Error(`expected a checkpoint, got ${String(exit.cause)}`);
    return exit.value;
  };

  const refusal: CaptureHarness['refusal'] = async (scopes, overrides) => {
    const exit = await capture(scopes, overrides);
    if (
      Exit.isSuccess(exit) ||
      exit.cause._tag !== 'Fail' ||
      exit.cause.error._tag !== 'CheckpointCaptureFailure'
    ) {
      throw new Error(
        `expected a capture refusal, got ${Exit.isSuccess(exit) ? 'a checkpoint' : String(exit.cause)}`,
      );
    }
    return exit.cause.error;
  };

  const entries = (checkpointId: number) =>
    db
      .select()
      .from(workflowCheckpointEntries)
      .where(eq(workflowCheckpointEntries.checkpointId, checkpointId))
      .orderBy(asc(workflowCheckpointEntries.seq))
      .all()
      .map(checkpointEntryRecord);

  // The workspace service and routes are built once, on first export, and torn down on close.
  const workspaceData = mkdtempSync(join(tmpdir(), 'isagi-checkpoint-export-data-'));
  let services: ReturnType<typeof makeServices> | undefined;
  const makeServices = () => {
    const runtime = ManagedRuntime.make(
      liveWorkspaceLayer(workspaceData, { database: fixture.database }),
    );
    return { runtime, workspace: runtime.runPromise(WorkspaceService) };
  };

  let exports = 0;
  const exportCheckpointFor: CaptureHarness['exportCheckpoint'] = async (record, destination) => {
    exports += 1;
    const target = destination ?? join(workspace.root, `export-${exports}`);
    services ??= makeServices();
    const workspaceService = await services.workspace;
    const projection = makeWorkflowRunProjection(
      fixture.database,
      fixture.payloads,
      fixture.content,
    );
    const routes = {
      runPromise: <A>(effect: Effect.Effect<A, unknown, never>) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provideService(WorkflowEngine, {} as never),
            Effect.provideService(WorkflowRunProjection, projection),
            Effect.provideService(WorkspaceService, workspaceService),
          ) as Effect.Effect<A, unknown, never>,
        ),
    } as never;
    const fastify = Fastify({ logger: false });
    registerWorkflowApi(fastify, routes);
    registerWorkspaceApi(fastify, routes);
    const url = await fastify.listen({ host: '127.0.0.1', port: 0 });
    try {
      const result = await Effect.runPromise(
        exportCheckpoint({
          runId: record.runId,
          checkpointId: record.checkpointKey,
          output: target,
          cwd: workspace.root,
          progress: () => {},
        }).pipe(Effect.provide(runtimeApiLayer(url))),
      );
      return { result, destination: target };
    } finally {
      await fastify.close();
    }
  };

  const inventory: CaptureHarness['inventory'] = async (record) => {
    const projection = makeWorkflowRunProjection(
      fixture.database,
      fixture.payloads,
      fixture.content,
    );
    const collected: WorkflowCheckpointInventoryEntry[] = [];
    let cursor: string | null = null;
    do {
      const page: ListWorkflowCheckpointInventoryOutput = await Effect.runPromise(
        projection.listCheckpointInventory(record.runId, record.checkpointKey, {
          limit: 500,
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      collected.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return collected;
  };

  const exported: CaptureHarness['exported'] = async (record, destination) => {
    const { result } = await exportCheckpointFor(record, destination);
    const described = JSON.stringify(result, null, 2);
    assert.equal(result.status, 'complete', `expected a complete export, got ${described}`);
    assert.equal(result.failure, null, described);
    assert.deepEqual(result.base, record.base, 'the export reports the checkpoint’s own base');
    if (record.base.kind === 'git') {
      assert.ok(
        Number.isInteger(result.worktreeId) && result.worktreeId! > 0,
        `a Git export reports its worktree, got ${String(result.worktreeId)}`,
      );
      assert.deepEqual(result.limitations, [
        'git_baseline_is_committed_state_only',
        'dependencies_not_captured',
      ]);
    } else {
      assert.equal(result.worktreeId, null, 'a directory-only export has no worktree');
      assert.deepEqual(result.limitations, [
        'no_baseline_captured_files_only',
        'dependencies_not_captured',
      ]);
    }
    return result.destinationPath;
  };

  return {
    fixture,
    workspace,
    repo,
    repository,
    worktreeId,
    projectId,
    git,
    write: (path, content, executable = false) => {
      const destination = join(repo, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
      chmodSync(destination, executable ? 0o755 : 0o644);
    },
    remove: (path) => rmSync(join(repo, path), { recursive: true, force: true }),
    commitAll: (message) => {
      git(['add', '-A']);
      git(['commit', '--quiet', '--allow-empty', '-m', message]);
      return git(['rev-parse', 'HEAD']).trim();
    },
    capture,
    captureOk,
    refusal,
    entries,
    checkpointCount: () =>
      (
        fixture.client.prepare('SELECT count(*) AS n FROM workflow_checkpoints').get() as {
          n: number;
        }
      ).n,
    exportCheckpoint: exportCheckpointFor,
    inventory,
    exported,
    close: () => {
      void services?.runtime.dispose();
      fixture.close();
      workspace.cleanup();
      rmSync(workspaceData, { recursive: true, force: true });
    },
  };
}

/**
 * Every regular file under `root` with its content and executable bit, keyed by the exact names the
 * directory entries carry. `.git` entries and links are left out: they are outside what a checkpoint
 * reconstructs.
 */
export function treeOf(root: string, under: readonly string[] = ['']): Record<string, TreeFile> {
  const files: Record<string, TreeFile> = {};
  const walk = (relative: string) => {
    const absolute = relative === '' ? root : join(root, relative);
    for (const name of readdirSync(absolute).sort()) {
      if (name === '.git') continue;
      const child = relative === '' ? name : `${relative}/${name}`;
      const stats = lstatSync(join(root, child));
      if (stats.isDirectory()) walk(child);
      else if (stats.isFile()) {
        files[child] = {
          content: readFileSync(join(root, child), 'utf8'),
          executable: (stats.mode & 0o100) !== 0,
        };
      }
    }
  };
  walk('');
  if (under.length === 1 && under[0] === '') return files;
  return Object.fromEntries(
    Object.entries(files).filter(([path]) =>
      under.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
    ),
  );
}

/**
 * A reader over the real filesystem that resolves spellings the way a case- and
 * normalization-insensitive filesystem does, on any host: a name missing from its parent's listing
 * is looked up there by folded spelling. Listings stay verbatim. On a host that is already
 * insensitive this changes nothing, so the same tests run everywhere.
 */
export function foldingReader(base: DirectoryReader = nodeDirectoryReader): DirectoryReader {
  const fold = (name: string) => name.normalize('NFC').toLowerCase();
  const notFound = (path: string) =>
    Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  const locate = async (absolute: string): Promise<string> => {
    try {
      await base.lstat(absolute);
      return absolute;
    } catch (cause) {
      if ((cause as { code?: unknown }).code !== 'ENOENT') throw cause;
      const parent = dirname(absolute);
      if (parent === absolute) throw cause;
      const located = await locate(parent);
      const wanted = fold(basename(absolute));
      const match = (await base.readdir(located)).find((name) => fold(name) === wanted);
      if (match === undefined) throw notFound(absolute);
      return join(located, match);
    }
  };
  return {
    readdir: (absolute) => locate(absolute).then((path) => base.readdir(path)),
    lstat: (absolute) => locate(absolute).then((path) => base.lstat(path)),
    // Like the platform: an alias resolves without being rewritten to the entry's spelling.
    realpath: async (absolute) => {
      const located = await locate(absolute);
      const real = await base.realpath(located);
      return located === absolute ? real : join(dirname(real), basename(absolute));
    },
  };
}

/** A reader that runs `hook` once, the first time `lstat` is asked about `target`. */
export function hookedReader(
  target: string,
  hook: () => void,
  base: DirectoryReader = nodeDirectoryReader,
): DirectoryReader {
  let fired = false;
  return {
    ...base,
    lstat: async (absolute): Promise<EntryStat> => {
      const stats = await base.lstat(absolute);
      if (!fired && absolute === target) {
        fired = true;
        hook();
      }
      return stats;
    },
  };
}
