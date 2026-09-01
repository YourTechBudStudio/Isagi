import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import type { ResolvedEditorInstallation } from '../../editor-provisioning/index.js';
import { readyEditorProvisioningLayer } from '../../editor-provisioning/test-support.js';
import { UserShell, type UserShellService } from '../../host-inventory/user-shell.service.js';
import { EntityLockLive, type EntityLockService } from '../../lib/locks/entity-lock.js';
import {
  LoopbackPortProbe,
  LoopbackPortProbeLive,
  type LoopbackPortProbeService,
} from '../../lib/net/loopback-port-probe.js';
import {
  DatabaseError,
  DataDirectory,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type RuntimeDatabaseService,
} from '../../persistence/index.js';
import { editorContexts, ptyProcesses, worktrees } from '../../persistence/schema.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import { PtyBackendCatalog } from '../../pty-processes/backend.js';
import { PtyForegroundStateLive } from '../../pty-processes/foreground-state.js';
import {
  PtyRepositoryLive,
  type PtyRepositoryService,
} from '../../pty-processes/pty.repository.js';
import {
  PtyServiceLive,
  type PtyService as PtyServiceShape,
} from '../../pty-processes/pty.service.js';
import { fakeBackendCatalog } from '../../pty-processes/test-support.js';
import type { PtyBackend, PtyBackendName } from '../../pty-processes/types.js';
import type {
  InternalRuntimeEvent,
  InternalRuntimeEventBusService,
} from '../../runtime-events/index.js';
import { recordingInternalEventBusLayer } from '../../runtime-events/test-support.js';
import {
  WorkspaceRepository,
  WorkspaceRepositoryLive,
  type WorkspaceRepositoryService,
} from '../../workspace/index.js';
import type { WorktreeRow } from '../../workspace/types.js';
import type { EditorContextRepositoryService } from '../editor-contexts.repository.js';
import { EditorContextRepositoryLive } from '../editor-contexts.repository.js';
import {
  EditorContextService,
  makeEditorContextService,
  type EditorContextServiceShape,
  type EditorContextServiceOptions,
  type EditorProbeRunner,
} from '../editor-contexts.service.js';
import type { EditorReadinessObservation } from '../types.js';

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
    const projectId = yield* workspace.insertProject({
      name: 'isagi',
      rootPath,
    });
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
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
          }),
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

// ---------------------------------------------------------------------------
// The service harness
// ---------------------------------------------------------------------------

/**
 * The launch path is exercised through the *real* PTY service and repository
 * over a fake backend adapter. The allocation/handoff/start ordering, the
 * explicit backend selection, the log metadata, and the terminal events this
 * domain interprets are all PTY-layer behaviour, and a stubbed `PtyService`
 * would assert against a re-implementation of them rather than the thing that
 * ships. No Code Server and no OS process are involved.
 */
export function testInstallation(root: string): ResolvedEditorInstallation {
  return {
    version: '4.135.0',
    installRoot: `${root}/tools/code-server/4.135.0`,
    executablePath: `${root}/tools/code-server/4.135.0/bin/code-server`,
    userDataPath: `${root}/editors/code-server/user-data`,
    extensionsPath: `${root}/editors/code-server/extensions`,
    sessionSocketDirectory: testSessionSocketDirectory(root),
    configPath: `${root}/editors/code-server/config.yaml`,
  };
}

/**
 * Deliberately not under the temporary data root, and this is not a shortcut.
 *
 * A UNIX socket path may not exceed 100 bytes, and on darwin `os.tmpdir()` is
 * itself around 50 of them — so a data root created there plus
 * `editors/code-server/sock/<id>-<token>.sock` genuinely crosses the cap and the
 * launch refuses before allocating, exactly as it should. Every test would then
 * be asserting the refusal rather than the behaviour it came for. `/tmp` exists
 * on both supported platforms and leaves the budget realistic instead of
 * pathological; the refusal itself is covered directly in `launch-spec.test.ts`
 * and `service.ensure.failures.test.ts`.
 */
export function testSessionSocketDirectory(root: string) {
  return join('/tmp', basename(root));
}

function testUserShell(): UserShellService {
  return {
    environment: {
      _tag: 'Available' as const,
      values: {
        HOME: '/home/developer',
        PATH: '/usr/bin:/bin',
        SHELL: '/bin/zsh',
      },
    },
    run: () => Effect.die('editor tests do not run user-shell commands.'),
  };
}

export function editorBackendStub(
  name: PtyBackendName,
  overrides: Partial<PtyBackend> = {},
): PtyBackend {
  return {
    name,
    available: Effect.succeed(true),
    launch: ({ ptyProcessId }) =>
      Effect.succeed({
        schemaVersion: 1 as const,
        backend: name,
        ...(name === 'tmux'
          ? { sessionName: `isagi_test_${ptyProcessId}` }
          : { ptyProcessId, pid: 4_242 }),
      } as never),
    writeInput: () => Effect.void,
    attach: () => Effect.die(`${name} attach is not expected in editor tests`),
    resize: () => Effect.void,
    replay: () => Effect.void,
    inspect: () => Effect.succeed({ alive: true }),
    kill: () => Effect.succeed({ terminated: true }),
    collectGarbage: () => Effect.succeed([]),
    ...overrides,
  } as PtyBackend;
}

export interface EditorServiceHarnessInput {
  readonly dataRoot: string;
  /**
   * Fail one named database operation. The operation labels are the runtime's
   * own, so this targets exactly one write without making the whole database
   * unusable — which is what a Class B failure at the handoff actually looks
   * like.
   */
  readonly failDatabaseOperation?: string | undefined;
  /**
   * Replace the worktree lookup. The launch re-reads the path immediately before
   * spawning, and a worktree that disappears in that window is otherwise
   * unreachable in a test: deleting the row cascades the editor context away
   * first.
   */
  readonly findWorktree?:
    | ((worktreeId: number) => Effect.Effect<WorktreeRow | null, DatabaseError>)
    | undefined;
  /** Override the installation, for the socket-budget refusal. */
  readonly installation?: ResolvedEditorInstallation | undefined;
  /** The launch preference. Editor incarnations must ignore it. */
  readonly configured?: PtyBackendName | undefined;
  readonly nodePty?: PtyBackend | undefined;
  readonly tmux?: PtyBackend | undefined;
  readonly events: InternalRuntimeEvent[];
  readonly options?: EditorContextServiceOptions | undefined;
  readonly portProbe?: LoopbackPortProbeService | undefined;
}

/**
 * The whole editor stack over one temporary data directory, with the internal
 * event bus recorded rather than replaced: the service both publishes and runs a
 * subscriber loop, so it needs the real delivery semantics.
 */
export function editorServiceLayer(input: EditorServiceHarnessInput) {
  mkdirSync(testSessionSocketDirectory(input.dataRoot), { recursive: true });
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(input.dataRoot));
  const liveDatabase = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  const database = input.failDatabaseOperation
    ? failingDatabaseLayer(input.failDatabaseOperation).pipe(Layer.provideMerge(liveDatabase))
    : liveDatabase;
  const liveWorkspace = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  const workspace = input.findWorktree
    ? overriddenWorktreeLookupLayer(input.findWorktree).pipe(Layer.provide(liveWorkspace))
    : liveWorkspace;
  const editorRepository = EditorContextRepositoryLive.pipe(Layer.provide(database));
  const ptyRepository = PtyRepositoryLive.pipe(Layer.provide(database));
  const bus = recordingInternalEventBusLayer(input.events);
  const catalog = Layer.succeed(
    PtyBackendCatalog,
    fakeBackendCatalog({
      configured: input.configured ?? 'node_pty',
      nodePty: input.nodePty ?? editorBackendStub('node_pty'),
      tmux: input.tmux ?? editorBackendStub('tmux'),
    }),
  );
  const pty = PtyServiceLive.pipe(
    Layer.provide(ptyRepository),
    Layer.provide(catalog),
    Layer.provide(PtyForegroundStateLive),
    Layer.provide(directory),
    Layer.provide(bus),
    Layer.provide(Layer.succeed(UserShell, testUserShell())),
  );
  const provisioning = readyEditorProvisioningLayer(
    input.installation ?? testInstallation(input.dataRoot),
  );
  const portProbe = input.portProbe
    ? Layer.succeed(LoopbackPortProbe, input.portProbe)
    : LoopbackPortProbeLive;
  // The same lock value the service is built on, so a test can take the lock the
  // way the placement path will and hand the service a genuine witness.
  const entityLock = EntityLockLive;
  const service = Layer.scoped(
    EditorContextService,
    makeEditorContextService(input.options ?? {}),
  ).pipe(
    Layer.provide(editorRepository),
    Layer.provide(workspace),
    Layer.provide(pty),
    Layer.provide(provisioning),
    Layer.provide(portProbe),
    Layer.provide(entityLock),
    Layer.provide(bus),
  );
  return Layer.mergeAll(
    database,
    workspace,
    editorRepository,
    ptyRepository,
    pty,
    bus,
    entityLock,
    service,
  );
}

/** A probe that never settles, so a test controls readiness entirely by itself. */
export const neverSettlingProbe: EditorProbeRunner = () => Effect.never;

/** A probe that settles immediately, for tests about registration and cleanup. */
export function immediateProbe(state: 'ready' | 'unreachable', detail: string | null = null) {
  const runner: EditorProbeRunner = ({ onSettled }) => onSettled({ state, detail });
  return runner;
}

export function editorContextChangedIds(events: readonly InternalRuntimeEvent[]) {
  return events.flatMap((event) =>
    event.type === 'editor_context_changed' ? [event.editorContextId] : [],
  );
}

/**
 * Wait for a registered probe to reach its settled state.
 *
 * The probe is forked, so even a stub that settles immediately does so on a
 * later scheduler turn than the ensure that registered it. Tests that assert on
 * a settled readiness have to wait for that turn rather than assume it, and this
 * makes the wait explicit instead of hiding it in an arbitrary sleep.
 */
export function awaitProbeSettled(ptyProcessId: number) {
  return Effect.gen(function* () {
    const service = yield* EditorContextService;
    return yield* Effect.iterate(undefined as EditorReadinessObservation | undefined, {
      while: (observation) => observation === undefined || observation.state === 'pending',
      body: () =>
        Effect.yieldNow().pipe(
          Effect.zipRight(service.readinessFor([ptyProcessId])),
          Effect.map((observations) => observations.get(ptyProcessId)),
        ),
    });
  });
}

export type EditorHarnessContext =
  | EditorContextServiceShape
  | EditorContextRepositoryService
  | RuntimeDatabaseService
  | WorkspaceRepositoryService
  | PtyRepositoryService
  | PtyServiceShape
  | EntityLockService
  | InternalRuntimeEventBusService;

/**
 * One editor stack over one throwaway data directory, torn down afterwards.
 *
 * `Effect.scoped` is what closes the service scope, so every test also exercises
 * the shutdown finalizer: a probe fiber left running here would keep the test
 * process alive and say so.
 */
export function withEditorService<A, E>(
  input: Omit<EditorServiceHarnessInput, 'dataRoot' | 'events'> & {
    readonly prefix?: string | undefined;
  },
  body: (events: InternalRuntimeEvent[]) => Effect.Effect<A, E, EditorHarnessContext>,
): Promise<A> {
  const dataRoot = mkdtempSync(join(tmpdir(), input.prefix ?? 'isagi-editor-'));
  const events: InternalRuntimeEvent[] = [];
  return Effect.runPromise(
    body(events).pipe(
      Effect.provide(editorServiceLayer({ ...input, dataRoot, events })),
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(dataRoot, { recursive: true, force: true });
          rmSync(testSessionSocketDirectory(dataRoot), {
            recursive: true,
            force: true,
          });
        }),
      ),
    ),
  );
}

function failingDatabaseLayer(operation: string) {
  return Layer.effect(
    RuntimeDatabase,
    Effect.gen(function* () {
      const database = yield* RuntimeDatabase;
      const refuse = <A>(name: string, run: () => Effect.Effect<A, DatabaseError>) =>
        name === operation
          ? Effect.fail(new DatabaseError({ operation: name, cause: new Error('forced failure') }))
          : run();
      return {
        use: (name, run) => refuse(name, () => database.use(name, run)),
        transaction: (name, run) => refuse(name, () => database.transaction(name, run)),
      } satisfies RuntimeDatabaseService;
    }),
  );
}

function overriddenWorktreeLookupLayer(
  findWorktree: (worktreeId: number) => Effect.Effect<WorktreeRow | null, DatabaseError>,
) {
  return Layer.effect(
    WorkspaceRepository,
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      return { ...repository, findWorktree } satisfies WorkspaceRepositoryService;
    }),
  );
}
