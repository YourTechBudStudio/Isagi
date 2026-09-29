import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Effect, Exit, Layer, Scope } from 'effect';

import type {
  RuntimeEvent,
  WorkflowPlacementRequestDto,
  WorktreeSetupResult,
} from '@isagi/contracts';

import { Git, GitLive } from '../../git/index.js';
import {
  DatabaseError,
  type RuntimeDatabaseService,
  type RuntimeDrizzleDatabase,
} from '../../persistence/database.service.js';
import { migrationsDirectory } from '../../persistence/migrations.js';
import * as schema from '../../persistence/schema.js';
import {
  InternalRuntimeEventBus,
  InternalRuntimeEventBusLive,
  type InternalRuntimeEventBusService,
  type RuntimeEventBusService,
} from '../../runtime-events/index.js';
import { DetachedWorktreeError } from '../../workspace/detached-worktree.js';
import { checkNewDirectory } from '../../workspace/new-directory.js';
import { WorkspaceError } from '../../workspace/workspace.service.js';
import { makeCheckpointsPort } from '../checkpoints/port.js';
import {
  makeWorkflowContentStore,
  type WorkflowContentStoreService,
} from '../store/content-store.js';
import type { Db } from '../store/rows.js';
import {
  describeWorkflowArtifact,
  WorkflowLoadError,
  type AnyWorkflowDefinition,
  type LoadedWorkflowArtifact,
  type PublishedWorkflowArtifact,
} from '../structure/loader.js';
import type { DiscoveredWorkflowEntry, WorkflowRegistryService } from '../structure/registry.js';
import type { WorkflowAgentHarness, WorkflowConversationMessage } from '../types.js';
import type { TurnEdge } from '../waits/latest-turn.js';
import type {
  AgentPort,
  CheckpointsPort,
  HeadlessExit,
  HeadlessPort,
  PlacesPort,
} from './runtime.js';
import { startEngine, type EngineHandle } from './service.js';

/**
 * The whole engine against a real, migrated SQLite database, with the outside world faked.
 *
 * Real: the schema, the store, the chain, the driver, the controls, restart handling, the event
 * push, the internal event bus that carries turn and PTY triggers, and the structural extractor that
 * turns a workflow definition into a build. Faked: discovery (definitions are registered in memory),
 * worktrees and surfaces, agent sessions and headless processes, each through its engine port.
 *
 * `restart()` stops the engine and starts a new one over the same database, which is what an app
 * restart is to the engine.
 */
export interface EngineHarness {
  readonly engine: EngineHandle;
  readonly db: Db;
  readonly events: RuntimeEvent[];
  readonly registry: FakeRegistry;
  readonly places: FakePlaces;
  readonly agents: FakeAgents;
  readonly headless: FakeHeadless;
  /** The seeded worktree's checkout, where operation and checkpoint nodes work. */
  readonly worktreePath: string;
  readonly internalEvents: InternalRuntimeEventBusService;
  /** Makes the next write with this operation name fail and roll back, as a full disk would. */
  readonly failNextWrite: (operation: string) => void;
  /** Runs an engine call to completion, then waits until background work has settled. */
  readonly run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  /** Like `run`, but hands back the failure instead of throwing. */
  readonly fail: (effect: Effect.Effect<unknown, unknown>) => Promise<unknown>;
  readonly settle: () => Promise<void>;
  /** Launches from the seeded worktree and surface. */
  readonly launch: (
    workflowKey: string,
    options?: {
      readonly inputs?: Record<string, unknown>;
      readonly placement?: WorkflowPlacementRequestDto;
    },
  ) => Promise<number>;
  readonly restart: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * `registry` replaces discovery with a real one, for proofs that load genuinely built packages;
 * `harness.registry` is then unused.
 */
export async function makeEngineHarness(
  options: { readonly registry?: WorkflowRegistryService } = {},
): Promise<EngineHarness> {
  const root = mkdtempSync(join(tmpdir(), 'isagi-workflow-engine-'));
  const client = new BetterSqlite(join(root, 'isagi.db'));
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  const drizzled = drizzle(client, { schema }) as RuntimeDrizzleDatabase;
  migrate(drizzled, { migrationsFolder: migrationsDirectory() });
  const failingWrites = new Set<string>();
  const database: RuntimeDatabaseService = {
    use: (operation, run) =>
      Effect.try({
        try: () => run(drizzled),
        catch: (cause) => new DatabaseError({ operation, cause }),
      }),
    transaction: (operation, run) =>
      Effect.try({
        try: () => {
          if (failingWrites.delete(operation)) throw new Error(`Injected failure of ${operation}.`);
          return drizzled.transaction((transaction) =>
            run(transaction as unknown as RuntimeDrizzleDatabase),
          );
        },
        catch: (cause) => new DatabaseError({ operation, cause }),
      }),
  };

  const worktreePath = join(root, 'worktree');
  mkdirSync(worktreePath, { recursive: true });
  const busScope = Effect.runSync(Scope.make());
  const busContext = await Effect.runPromise(
    Layer.buildWithScope(InternalRuntimeEventBusLive, busScope),
  );
  const internalEvents = busContext.unsafeMap.get(InternalRuntimeEventBus.key) as
    | InternalRuntimeEventBusService
    | undefined;
  if (!internalEvents) throw new Error('The internal event bus did not build.');

  const events: RuntimeEvent[] = [];
  const publicEvents: RuntimeEventBusService = {
    publish: (event) => Effect.sync(() => void events.push(event)),
    subscribe: Effect.die('Tests read published events from the array.'),
  };
  const registry = new FakeRegistry();
  const places = new FakePlaces(root, worktreePath, client);
  const content = makeWorkflowContentStore(join(root, 'workflow-content'));
  const clock = new FakeClock();
  const agents = new FakeAgents(clock, internalEvents);
  const headless = new FakeHeadless(internalEvents);

  let scope = Effect.runSync(Scope.make());
  const start = () =>
    Effect.runPromise(
      Scope.extend(
        startEngine({
          database,
          events: publicEvents,
          deps: {
            registry: options.registry ?? registry,
            places: places.port(),
            agents: agents.port(),
            headless: headless.port(),
            checkpoints: places.checkpointsPort(content),
            internalEvents,
          },
        }),
        scope,
      ),
    );
  let engine = await start();

  const harness: EngineHarness = {
    get engine() {
      return engine;
    },
    db: drizzled,
    events,
    registry,
    places,
    agents,
    headless,
    worktreePath,
    internalEvents,
    failNextWrite: (operation) => void failingWrites.add(operation),
    run: async (effect) => {
      const value = await Effect.runPromise(effect);
      await harness.settle();
      return value;
    },
    fail: async (effect) => {
      const exit = await Effect.runPromiseExit(effect);
      await harness.settle();
      if (Exit.isSuccess(exit)) throw new Error('Expected the call to fail, and it succeeded.');
      const failure = exit.cause._tag === 'Fail' ? exit.cause.error : exit.cause;
      return failure;
    },
    settle: () => Effect.runPromise(engine.awaitIdle),
    launch: async (workflowKey, launchOptions = {}) => {
      const { runId } = await harness.run(
        engine.launch({
          workflowKey,
          inputs: launchOptions.inputs ?? {},
          origin: { worktreeId: 1, surfaceId: 1 },
          ...(launchOptions.placement ? { placement: launchOptions.placement } : {}),
        }),
      );
      return runId;
    },
    restart: async () => {
      // Deliberately no settle first: a restart can cut off a node function mid-run.
      await Effect.runPromise(Scope.close(scope, Exit.void));
      scope = Effect.runSync(Scope.make());
      engine = await start();
      await harness.settle();
    },
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await Effect.runPromise(Scope.close(busScope, Exit.void));
      client.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return harness;
}

export async function withEngine(body: (harness: EngineHarness) => Promise<void>): Promise<void> {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

/** Increasing ISO timestamps, so turn edges order deterministically after the prompts they answer. */
export class FakeClock {
  private at = Date.parse('2026-01-01T00:00:00.000Z');
  now(): string {
    this.at += 1_000;
    return new Date(this.at).toISOString();
  }
}

/**
 * Discovery in memory. `publish` registers a new build of a workflow and makes it the latest one,
 * which is what Resume and Retry reload; earlier builds stay loadable by hash.
 */
export class FakeRegistry implements WorkflowRegistryService {
  private readonly latest = new Map<string, PublishedWorkflowArtifact>();
  private readonly byHash = new Map<string, LoadedWorkflowArtifact>();
  private builds = 0;
  failNextLoad: string | null = null;

  publish(workflowKey: string, definition: AnyWorkflowDefinition): string {
    this.builds += 1;
    const hash = createHash('sha256').update(`${workflowKey}:${this.builds}`).digest('hex');
    const artifact = describeWorkflowArtifact({ default: definition }, hash, { workflowKey });
    const published: PublishedWorkflowArtifact = {
      ...artifact,
      versions: { sdkVersion: '0.1.0', verifierVersion: '0.1.0', contractVersion: 5 },
    };
    this.latest.set(workflowKey, published);
    this.byHash.set(hash, artifact);
    return hash;
  }

  discover: WorkflowRegistryService['discover'] = () =>
    Effect.sync(() => {
      const entries: DiscoveredWorkflowEntry[] = [...this.latest.entries()].map(
        ([workflowKey, build]) => ({
          workflowKey,
          load: () => {
            if (this.failNextLoad === workflowKey) {
              this.failNextLoad = null;
              return Effect.fail(
                new WorkflowLoadError({
                  reason: 'stale_source',
                  message: 'Workflow source differs from the verified build.',
                  workflowKey,
                }),
              );
            }
            return Effect.succeed(build);
          },
        }),
      );
      return { entries, find: (key) => entries.find((entry) => entry.workflowKey === key) };
    });

  loadPinned: WorkflowRegistryService['loadPinned'] = (artifactHash, workflowKey) => {
    const artifact = this.byHash.get(artifactHash);
    return artifact
      ? Effect.succeed(artifact)
      : Effect.fail(
          new WorkflowLoadError({
            reason: 'artifact_load_failed',
            message: 'Unknown build.',
            workflowKey,
            artifactHash,
          }),
        );
  };
}

interface FakeWorktree {
  readonly id: number;
  readonly projectId: number;
  readonly path: string;
  readonly branch: string | null;
}

/**
 * One project (id 1) with one worktree (id 1) and one surface (id 1). Worktree creation, setup and
 * surface creation are recorded, and can be made to fail.
 */
export class FakePlaces {
  readonly worktrees = new Map<number, FakeWorktree>();
  readonly surfaces = new Map<
    number,
    { readonly id: number; readonly worktreeId: number; readonly title: string }
  >();
  /** Agent panes by surface, as `getSurfaceDetail` reports them to the launch origin check. */
  readonly agentPanes = new Map<
    number,
    { readonly paneId: number; readonly agentSessionId: number }[]
  >();
  readonly refs = new Map<string, string>([['main', 'a'.repeat(40)]]);
  readonly calls: string[] = [];
  /** What the next worktree setup reports: the one in `openWorktree`, then each rerun. */
  setupResults: ('succeeded' | 'failed')[] = [];
  failSurfaceCreation = false;
  /** The seeded project's kind; `folder` makes checkpoints record no commit. */
  projectKind: 'git' | 'folder' = 'git';
  private nextWorktree = 2;
  private nextSurface = 2;

  /**
   * The rows are also written to the real tables, because a run's `surface_id` is a real foreign
   * key: deleting a surface releases its run.
   */
  constructor(
    private readonly root: string,
    worktreePath: string,
    private readonly client: BetterSqlite.Database,
  ) {
    client
      .prepare(
        `INSERT INTO projects (id, name, root_path, kind, status, created_at, updated_at) VALUES (1, 'Project', ?, 'git', 'present', '', '')`,
      )
      .run(root);
    this.addWorktree(1, worktreePath, 'main');
    this.saveSurface(1, 1, 'Main');
  }

  addSurface(worktreeId: number): number {
    const id = this.nextSurface++;
    this.saveSurface(id, worktreeId, `Surface ${id}`);
    return id;
  }

  /** Puts an agent session's pane on a surface, so a launch can name it as its origin. */
  addAgentPane(surfaceId: number, agentSessionId: number): number {
    const paneId = 2000 + agentSessionId;
    this.agentPanes.set(surfaceId, [
      ...(this.agentPanes.get(surfaceId) ?? []),
      { paneId, agentSessionId },
    ]);
    return paneId;
  }

  deleteSurface(surfaceId: number): void {
    this.surfaces.delete(surfaceId);
    this.client.prepare('DELETE FROM worktree_surfaces WHERE id = ?').run(surfaceId);
  }

  private addWorktree(id: number, path: string, branch: string): void {
    this.worktrees.set(id, { id, projectId: 1, path, branch });
    this.client
      .prepare(
        `INSERT INTO worktrees (id, project_id, path, branch, created_at, updated_at, first_seen_at) VALUES (?, 1, ?, ?, '', '', '')`,
      )
      .run(id, path, branch);
  }

  private saveSurface(id: number, worktreeId: number, title: string): void {
    this.surfaces.set(id, { id, worktreeId, title });
    this.client
      .prepare(
        `INSERT INTO worktree_surfaces (id, worktree_id, title, layout_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, '{}', 0, '', '')`,
      )
      .run(id, worktreeId, title);
  }

  private setup(): Exclude<WorktreeSetupResult, { status: 'not_run' }> {
    const next = this.setupResults.shift() ?? 'succeeded';
    return next === 'succeeded'
      ? { status: 'succeeded', runId: 1 }
      : {
          status: 'failed',
          runId: 1,
          failedHookIndex: 1,
          failedHookType: 'command',
          message: 'the setup hook exited with 1',
        };
  }

  /**
   * Checkpoints over real Git and a real content store. The new-directory rule is the real one,
   * over these rows; a detached worktree is a real `git worktree add --detach` from the seeded
   * worktree, registered here instead of by reconciliation.
   */
  checkpointsPort(content: WorkflowContentStoreService): CheckpointsPort {
    const repository = {
      listProjects: Effect.sync(() => [{ rootPath: this.root }] as never),
      listWorktrees: Effect.sync(() => [...this.worktrees.values()] as never),
    };
    const git = Effect.runSync(Effect.provide(Git, GitLive));
    const checkNew = (path: string) => checkNewDirectory(repository, path);
    return makeCheckpointsPort({
      git,
      content,
      workspace: {
        checkNewDirectory: checkNew,
        createDetachedWorktree: (input) =>
          Effect.gen(this, function* () {
            const failure = (
              reason: DetachedWorktreeError['reason'],
              message: string,
              extra: Partial<DetachedWorktreeError> = {},
            ) =>
              new DetachedWorktreeError({
                reason,
                message,
                projectId: input.projectId,
                path: input.path,
                ...extra,
              });
            if (input.projectId !== 1 || this.projectKind !== 'git') {
              return yield* Effect.fail(failure('project_unavailable', 'Not a Git project.'));
            }
            const source = this.worktrees.get(1)!.path;
            const destination = yield* checkNew(input.path).pipe(
              Effect.catchTag('NewDirectoryRejected', (rejected) =>
                Effect.fail(
                  failure('destination_rejected', rejected.message, {
                    path: rejected.path,
                    destinationIssue: rejected.issue,
                  }),
                ),
              ),
            );
            const verified = yield* git
              .run(['-C', source, 'cat-file', '-e', `${input.commit}^{commit}`])
              .pipe(Effect.either);
            if (verified._tag === 'Left') {
              return yield* Effect.fail(
                failure('commit_not_found', `Commit ${input.commit} is not in the repository.`),
              );
            }
            yield* git
              .run(['-C', source, 'worktree', 'add', '--detach', destination, input.commit])
              .pipe(Effect.mapError((cause) => failure('git_add_failed', cause.stderr)));
            const id = this.nextWorktree++;
            this.addWorktree(id, destination, '');
            return { projectId: 1, worktreeId: id, path: destination, head: input.commit };
          }),
      },
    });
  }

  port(): PlacesPort {
    const worktreeRow = (worktree: FakeWorktree) => ({
      ...worktree,
      head: null,
      createdAt: '',
      updatedAt: '',
      firstSeenAt: '',
      lastSeenAt: null,
    });
    return {
      workspace: {
        findWorktree: (id) =>
          Effect.sync(() => {
            const worktree = this.worktrees.get(id);
            return worktree ? worktreeRow(worktree) : null;
          }),
        findProject: (id) =>
          Effect.succeed(
            id === 1
              ? {
                  id: 1,
                  name: 'Project',
                  rootPath: this.root,
                  kind: this.projectKind,
                  status: 'present' as const,
                  createdAt: '',
                  updatedAt: '',
                  lastSeenAt: null,
                  missingReason: null,
                }
              : null,
          ),
        listWorktrees: Effect.sync(() => [...this.worktrees.values()].map(worktreeRow)),
      } as PlacesPort['workspace'],
      workspaceService: {
        preflightWorktreeCreation: (input) => {
          const commit = this.refs.get(input.fromRef);
          return commit
            ? Effect.succeed({ commit, checkoutPath: join(this.root, input.branch) })
            : Effect.fail(
                new WorkspaceError({
                  code: 'base_ref_not_found',
                  message: `Ref ${input.fromRef} was not found.`,
                }),
              );
        },
        openWorktree: (input) =>
          Effect.sync(() => {
            const base = input.request.base;
            this.calls.push(
              `openWorktree ${input.request.branch} ${base?.kind === 'commit' ? base.commit : '?'}`,
            );
            const id = this.nextWorktree++;
            const path = join(this.root, input.request.branch);
            mkdirSync(path, { recursive: true });
            this.addWorktree(id, path, input.request.branch);
            const setup = this.setup();
            return setup.status === 'failed'
              ? {
                  projectId: 1,
                  worktreeId: id,
                  branch: input.request.branch,
                  status: 'created_setup_failed' as const,
                  setup,
                }
              : {
                  projectId: 1,
                  worktreeId: id,
                  branch: input.request.branch,
                  status: 'created' as const,
                  setup,
                };
          }),
        runWorktreeSetup: (input) =>
          Effect.sync(() => {
            this.calls.push(`runWorktreeSetup ${input.worktreeId}`);
            return this.setup();
          }),
      } as PlacesPort['workspaceService'],
      surfaceRepository: {
        findSurface: (id) => Effect.sync(() => (this.surfaces.get(id) ?? null) as never),
        listWorkspaceSurfaceMetadata: Effect.sync(() => [...this.surfaces.values()] as never),
      },
      surfaces: {
        getSurfaceDetail: (id) =>
          Effect.suspend(() => {
            const surface = this.surfaces.get(id);
            return surface
              ? Effect.succeed({
                  ...surface,
                  panes: (this.agentPanes.get(id) ?? []).map((pane) => ({
                    id: pane.paneId,
                    session: { kind: 'agent_session', agentSession: { id: pane.agentSessionId } },
                  })),
                  layout: { kind: 'leaf', paneId: 1 },
                } as never)
              : Effect.fail(new Error(`Surface ${id} was not found.`) as never);
          }),
        createEmptySurface: (input) =>
          Effect.suspend(() => {
            this.calls.push(`createSurface ${input.titleBase}`);
            if (this.failSurfaceCreation) {
              return Effect.fail(new Error('The surface could not be created.') as never);
            }
            const id = this.nextSurface++;
            this.saveSurface(id, input.worktreeId, input.titleBase);
            return Effect.succeed({ surfaceId: id, title: input.titleBase });
          }),
      },
    };
  }
}

interface FakeSession {
  readonly harness: WorkflowAgentHarness;
  alive: boolean;
  readonly edges: TurnEdge[];
  readonly replies: Map<number, string>;
  nextSeq: number;
  openSeq: number | null;
}

/**
 * Agent sessions as the engine sees them: spawns and sends are recorded, and a test drives the
 * turns — `startTurn`, `endTurn`, `failTurn` — which reach the engine as turn events on the bus.
 */
export class FakeAgents {
  readonly sessions = new Map<number, FakeSession>();
  readonly prompts: {
    readonly kind: 'spawn' | 'send';
    readonly agentSessionId: number;
    readonly prompt: string;
    readonly sentAt: string;
  }[] = [];
  readonly closedPanes: number[] = [];
  refreshFails = false;
  private nextSession = 1;

  constructor(
    private readonly clock: FakeClock,
    private readonly bus: InternalRuntimeEventBusService,
  ) {}

  /** An agent session that already exists, such as the one a workflow is launched from. */
  addSession(harness: WorkflowAgentHarness = 'claude'): number {
    const agentSessionId = this.nextSession++;
    this.sessions.set(agentSessionId, {
      harness,
      alive: true,
      edges: [],
      replies: new Map(),
      nextSeq: 1,
      openSeq: null,
    });
    return agentSessionId;
  }

  port(): AgentPort {
    return {
      spawn: (input) =>
        Effect.gen(this, function* () {
          const agentSessionId = this.nextSession++;
          this.sessions.set(agentSessionId, {
            harness: input.harness,
            alive: true,
            edges: [],
            replies: new Map(),
            nextSeq: 1,
            openSeq: null,
          });
          yield* input.onCreated({ paneId: 1000 + agentSessionId, agentSessionId });
          const sentAt = this.clock.now();
          this.prompts.push({ kind: 'spawn', agentSessionId, prompt: input.prompt, sentAt });
          return { agentSessionId, paneId: 1000 + agentSessionId, sentAt, harnessSessionId: 'h1' };
        }),
      send: (input) =>
        Effect.suspend(() => {
          const session = this.sessions.get(input.agentSessionId);
          if (!session) return Effect.fail(new Error(`No agent session ${input.agentSessionId}.`));
          const sentAt = this.clock.now();
          this.prompts.push({
            kind: 'send',
            agentSessionId: input.agentSessionId,
            prompt: input.prompt,
            sentAt,
          });
          return Effect.succeed({ sentAt });
        }),
      closePane: (input) => Effect.sync(() => void this.closedPanes.push(input.paneId)),
      harnessOf: (agentSessionId) =>
        Effect.succeed(this.sessions.get(agentSessionId)?.harness ?? 'claude'),
      conversation: (agentSessionId, turn) =>
        Effect.sync((): readonly WorkflowConversationMessage[] => {
          const session = this.sessions.get(agentSessionId);
          const text = turn
            ? session?.replies.get(turn.seq)
            : [...(session?.replies.values() ?? [])].at(-1);
          return text === undefined ? [] : [{ role: 'assistant', parts: [{ type: 'text', text }] }];
        }),
      turnEdges: (agentSessionId, refresh) =>
        refresh && this.refreshFails
          ? Effect.fail(new Error('The harness records could not be read.'))
          : Effect.succeed([...(this.sessions.get(agentSessionId)?.edges ?? [])]),
      isAlive: (agentSessionId) =>
        Effect.succeed(this.sessions.get(agentSessionId)?.alive ?? false),
    };
  }

  /** A turn starting in the session, as the harness observer would report it. */
  async startTurn(agentSessionId: number): Promise<number> {
    const session = this.require(agentSessionId);
    const seq = session.nextSeq++;
    session.openSeq = seq;
    const recordedAt = this.clock.now();
    session.edges.push({
      type: 'turn_started',
      agentSessionId,
      harnessSessionId: 'h1',
      seq,
      recordedAt,
    });
    await Effect.runPromise(
      this.bus.publish({
        type: 'turn_started',
        agentSessionId,
        harnessSessionId: 'h1',
        seq,
        recordedAt,
      }),
    );
    return seq;
  }

  /**
   * Ends the open turn (starting one first if none is open) with the agent's reply. A `null` reply
   * is a turn whose conversation cannot be read.
   */
  async endTurn(agentSessionId: number, reply: string | null = 'Done.'): Promise<void> {
    const session = this.require(agentSessionId);
    const seq = session.openSeq ?? (await this.startTurn(agentSessionId));
    session.openSeq = null;
    if (reply !== null) session.replies.set(seq, reply);
    const recordedAt = this.clock.now();
    session.edges.push({
      type: 'turn_ended',
      agentSessionId,
      harnessSessionId: 'h1',
      seq,
      recordedAt,
    });
    await Effect.runPromise(
      this.bus.publish({
        type: 'turn_ended',
        agentSessionId,
        harnessSessionId: 'h1',
        seq,
        recordedAt,
      }),
    );
  }

  async failTurn(agentSessionId: number, reason = 'harness_error' as const): Promise<void> {
    const session = this.require(agentSessionId);
    const seq = session.openSeq ?? (await this.startTurn(agentSessionId));
    session.openSeq = null;
    const recordedAt = this.clock.now();
    session.edges.push({
      type: 'turn_failed',
      agentSessionId,
      harnessSessionId: 'h1',
      seq,
      recordedAt,
      reason,
    });
    await Effect.runPromise(
      this.bus.publish({
        type: 'turn_failed',
        agentSessionId,
        harnessSessionId: 'h1',
        seq,
        recordedAt,
        reason,
      }),
    );
  }

  private require(agentSessionId: number): FakeSession {
    const session = this.sessions.get(agentSessionId);
    if (!session) throw new Error(`No agent session ${agentSessionId}.`);
    return session;
  }
}

/** Headless processes: started ones are recorded, and a test finishes them with their output. */
export class FakeHeadless {
  readonly started: {
    readonly ptyProcessId: number;
    readonly prompt: string;
    readonly harness: WorkflowAgentHarness;
  }[] = [];
  readonly terminated: number[] = [];
  terminateFails = false;
  captureFails = false;
  /** Every launch waits on this before returning, so a test can hold one in flight. */
  launchGate: Promise<void> = Promise.resolve();
  private readonly exits = new Map<number, HeadlessExit>();
  private readonly outputs = new Map<number, string>();
  private nextProcess = 1;

  constructor(private readonly bus: InternalRuntimeEventBusService) {}

  port(): HeadlessPort {
    return {
      start: (input) =>
        Effect.promise(async () => {
          const ptyProcessId = this.nextProcess++;
          this.started.push({ ptyProcessId, prompt: input.prompt, harness: input.harness });
          await this.launchGate;
          return { ptyProcessId };
        }),
      exitOf: (ptyProcessId) => Effect.succeed(this.exits.get(ptyProcessId) ?? null),
      capture: (input) =>
        this.captureFails
          ? Effect.fail(new Error(`The log of process ${input.ptyProcessId} is unreadable.`))
          : Effect.succeed({
              output: this.outputs.get(input.ptyProcessId) ?? '',
              semanticError: null,
              harnessSessionId: null,
              usage: null,
            }),
      // A successful stop is a killed process, as the PTY service reports it.
      terminate: (ptyProcessId) =>
        this.terminateFails
          ? Effect.fail(new Error(`Process ${ptyProcessId} would not stop.`))
          : Effect.sync(() => {
              this.terminated.push(ptyProcessId);
              this.exits.set(ptyProcessId, { status: 'killed', exitCode: null });
            }),
      release: () => Effect.void,
    };
  }

  /** A started process that has not exited yet, found by its prompt. */
  runningWithPrompt(prompt: string): number | null {
    const found = this.started.find(
      (process) => process.prompt === prompt && !this.exits.has(process.ptyProcessId),
    );
    return found?.ptyProcessId ?? null;
  }

  /** The process exits, with this output. Its exit reaches the engine as a PTY event. */
  async finish(ptyProcessId: number, output: string, exitCode = 0): Promise<void> {
    this.outputs.set(ptyProcessId, output);
    this.exits.set(ptyProcessId, { status: 'exited', exitCode });
    await Effect.runPromise(
      this.bus.publish({
        type: 'pty_process_exited',
        ptyProcessId,
        status: 'exited',
        exitCode,
        signal: null,
      }),
    );
  }
}
