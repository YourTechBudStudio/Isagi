/**
 * A real destination for checkpoint capture tests: a Git repository (or plain folder) registered as
 * a project with a worktree row, a migrated database, a real content store, and one run whose
 * visits each get their own execution and attempt.
 *
 * Also the test-only rebuild: applying one checkpoint's stored inventory rows to a fresh worktree at
 * that checkpoint's own base (or an empty directory without one). Public reads and export belong to
 * later work, so the rows are read directly here; what this proves is that the stored final state
 * is enough to reconstruct what was declared.
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Effect, Exit } from 'effect';

import { Git, GitLive, type GitService } from '../../git/git.command.js';
import { createFixtureWorkspace, type FixtureWorkspace } from '../../git/tests/fixtures.js';
import type { DatabaseError } from '../../persistence/index.js';
import {
  workflowCheckpointEntries,
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowRuns,
  workflowSegmentAttempts,
} from '../../persistence/schema.js';
import { nodeDirectoryReader, type DirectoryReader, type EntryStat } from '../paths.js';
import type {
  WorkflowCheckpointEntryRecord,
  WorkflowCheckpointRecord,
} from '../persistence/records.js';
import { checkpointEntryRecord } from '../persistence/row-mappers.js';
import {
  makeWorkflowPersistenceFixture,
  run,
  type WorkflowPersistenceFixture,
} from '../persistence/test-support.js';
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
  /** A fresh directory holding the checkpoint's reconstructed state. */
  readonly rebuild: (
    record: WorkflowCheckpointRecord,
    order: 'files_first' | 'absences_first',
  ) => Promise<string>;
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

  let rebuilds = 0;
  const rebuild: CaptureHarness['rebuild'] = async (record, order) => {
    rebuilds += 1;
    const target = join(workspace.root, `rebuild-${rebuilds}`);
    if (record.base.kind === 'git') {
      git(['worktree', 'add', '--quiet', '--detach', target, record.base.commitSha]);
    } else {
      mkdirSync(target);
    }
    const rows = entries(record.id);
    const files = rows.filter((row) => row.kind === 'file');
    const absences = rows.filter((row) => row.kind === 'absent');
    const writeFiles = async () => {
      for (const file of files) {
        const bytes = await run(fixture.content.readAll(file.contentRef));
        const destination = join(target, file.path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
        chmodSync(destination, file.executable ? 0o755 : 0o644);
      }
    };
    const removeAbsences = () => {
      for (const absence of absences) rmSync(join(target, absence.path), { force: true });
    };
    if (order === 'files_first') {
      await writeFiles();
      removeAbsences();
    } else {
      removeAbsences();
      await writeFiles();
    }
    return target;
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
    rebuild,
    close: () => {
      fixture.close();
      workspace.cleanup();
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
