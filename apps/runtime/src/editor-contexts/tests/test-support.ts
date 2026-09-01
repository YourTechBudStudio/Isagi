import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import { DataDirectory, RuntimeDatabase, RuntimeDatabaseLive } from '../../persistence/index.js';
import { editorContexts, ptyProcesses, worktrees } from '../../persistence/schema.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import { WorkspaceRepository, WorkspaceRepositoryLive } from '../../workspace/index.js';
import { EditorContextRepositoryLive } from '../index.js';

export function testLayer(dataRoot: string) {
  const dataDirectoryLayer = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  return Layer.mergeAll(
    database,
    WorkspaceRepositoryLive.pipe(Layer.provide(database)),
    EditorContextRepositoryLive.pipe(Layer.provide(database)),
  );
}

export function insertWorktree(rootPath: string) {
  return Effect.gen(function* () {
    const workspace = yield* WorkspaceRepository;
    const projectId = yield* workspace.insertProject({ name: 'isagi', rootPath });
    yield* workspace.reconcileProjectWorktrees({
      projectId,
      discovered: [{ path: rootPath, branch: 'main', head: 'abcdef0' }],
    });
    const rows = yield* workspace.listWorktrees;
    const worktree = rows.find((candidate) => candidate.projectId === projectId);
    if (!worktree) return yield* Effect.die('Expected test worktree to be inserted.');
    return worktree.id;
  });
}

export function deleteWorktree(worktreeId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_delete_worktree', (db) => {
      db.delete(worktrees).where(eq(worktrees.id, worktreeId)).run();
    });
  });
}

export function insertPtyProcess(status: 'running' | 'exited' = 'running') {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_insert_pty_process', (db) => {
      const now = new Date().toISOString();
      return db
        .insert(ptyProcesses)
        .values({
          backend: 'node_pty',
          backendRefJson: JSON.stringify({ schemaVersion: 1, backend: 'node_pty' }),
          command: 'code-server',
          argsJson: JSON.stringify(['--auth', 'none']),
          cwd: '/repo/isagi',
          status,
          statusReason: null,
          exitCode: status === 'exited' ? 0 : null,
          signal: null,
          logMode: 'backend_file',
          logPath: '/tmp/editor.log',
          createdAt: now,
          updatedAt: now,
          exitedAt: status === 'exited' ? now : null,
          lastSeenAt: null,
        })
        .returning({ id: ptyProcesses.id })
        .get().id;
    });
  });
}

/**
 * Writes column values the repository's transitions cannot produce. It exists
 * only so the invariant checks can be proven non-vacuous against a real row.
 */
export function forceEditorContextColumns(
  editorContextId: number,
  values: Partial<typeof editorContexts.$inferInsert>,
) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_force_editor_context_columns', (db) => {
      db.update(editorContexts).set(values).where(eq(editorContexts.id, editorContextId)).run();
    });
  });
}
