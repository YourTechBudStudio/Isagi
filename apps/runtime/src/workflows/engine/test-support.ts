import { createHash } from 'node:crypto';

import type { WorkflowStructureDescriptor } from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { Effect, Exit, Scope } from 'effect';

import type { WorkflowLoadFailureReason } from '@isagi/contracts';

import { DatabaseError } from '../../persistence/index.js';
import type { InternalRuntimeEvent } from '../../runtime-events/internal-event-bus.js';
import {
  makeWorkflowOperationService,
  type WorkflowOperationServiceShape,
} from '../operations/operation.service.js';
import {
  makeFakeAdapters,
  makeFakeAdapterState,
  type FakeAdapterState,
} from '../operations/test-support.js';
import type { WorkflowArtifactRecord, WorkflowRunRecord } from '../persistence/records.js';
import {
  makeWorkflowPersistenceFixture,
  run,
  type WorkflowPersistenceFixture,
} from '../persistence/test-support.js';
import type { WorkflowArtifactCatalogService } from '../structure/artifact-catalog.js';
import {
  describeWorkflowArtifact,
  WorkflowLoadError,
  type AnyWorkflowDefinition,
  type LoadedWorkflowArtifact,
} from '../structure/loader.js';
import type { WorkflowRegistryService } from '../structure/registry.js';
import { makeWaitResolver, type WaitResolver } from '../waits/resolver.js';
import { makeControls } from './controls.js';
import { makeDispatcher, type Dispatcher } from './dispatcher.js';
import { startWorkflow, type LaunchDeps } from './launch.js';
import { recoverAtStartup } from './recovery.js';

/**
 * A whole workflow runtime, minus the parts that would make a test a integration-with-the-world test.
 *
 * Real throughout the layers this phase is about: a real SQLite database migrated exactly as the
 * runtime migrates it, the real repositories, the real payload store, the real operation service,
 * the real structural extractor and the real interpreter. Only two seams are replaced, and both are
 * deliberate:
 *
 * - **the capability adapters**, by the fakes phase 03 built, because a live provider is not a test
 *   dependency and because every rule here is about *how many times* an effect crossed a boundary;
 * - **esbuild**, by a catalog that describes an in-memory module through the real extractor. The
 *   structure a test runs against is therefore produced by the same code a packaged workflow's is.
 *
 * What is emphatically not faked is the recovery boundary: `restart()` tears the service down and
 * builds a new one against the same database, so "a new incarnation" is a real new incarnation
 * rather than a flag.
 */
export interface EngineHarness {
  readonly fixture: WorkflowPersistenceFixture;
  readonly adapters: FakeAdapterState;
  readonly events: InternalRuntimeEvent[];
  /** The placement every launch targets unless one is named explicitly. */
  readonly placement: Placement;
  /**
   * An additional, independent environment: its own project, worktree and surface.
   *
   * Deliberately additive — it never changes where existing launches go, so a test that needs two
   * environments cannot quietly move the default one out from under the others.
   */
  readonly seedPlacement: () => Placement;
  /** Make the next call to one named commit fail and roll back, exactly as a crash would. */
  readonly crashNext: (commit: CommitName) => void;
  /**
   * Make the next artifact resolution fail, as an unverified or tampered build does.
   *
   * A real `WorkflowLoadError` with a real reason, so the launch path's mapping to
   * `workflow_load_failed` is what gets exercised rather than a thrown defect.
   */
  readonly breakNextLoad: (reason?: WorkflowLoadFailureReason) => void;
  /** Registers a version of a workflow and returns the pin it will be published under. */
  readonly publish: (input: {
    readonly workflowKey: string;
    readonly version: string;
    readonly definition: AnyWorkflowDefinition;
  }) => string;
  /** Makes one registered version the one discovery returns, which is what Retry adopts. */
  readonly setCurrent: (workflowKey: string, version: string) => void;
  readonly launch: (input: {
    readonly workflowKey: string;
    readonly inputs?: Record<string, unknown>;
    /** Defaults to the harness placement. */
    readonly placement?: Placement;
  }) => Promise<WorkflowRunRecord>;
  /** Launch without unwrapping the failure, for the rejections that must leave no run behind. */
  readonly launchExit: (input: {
    readonly workflowKey: string;
    readonly inputs?: Record<string, unknown>;
    readonly origin?: { readonly worktreeId: number; readonly surfaceId: number };
  }) => Promise<Exit.Exit<WorkflowRunRecord, unknown>>;
  readonly drain: () => Promise<number>;
  /**
   * What the resolver's subscriber does when an event reaches it.
   *
   * Called explicitly rather than through a forked subscriber so a test is deterministic, but it is
   * the same `reconcileWaits` the subscriber calls. A test that never needs it has proved delivery
   * happened at arm time.
   */
  readonly deliver: (runId?: number) => Promise<number>;
  /**
   * Settles an operation the way the operation service does, notification included.
   *
   * Tests drive the external world through this rather than through the repository alone, so the
   * `workflow_operation_settled` a real settlement publishes is present for whatever is listening.
   */
  readonly settleOperation: (input: {
    readonly operationId: number;
    readonly state: 'completed' | 'failed' | 'interrupted' | 'uncertain';
    readonly result?: unknown;
  }) => Promise<void>;
  /** Runs inside the window between a suspend committing and its arm-time reconciliation. */
  readonly onArmTimeReconcile: (hook: (waitId: number) => Promise<void> | void) => void;
  /**
   * Runs while a control is resolving an artifact, outside any transaction.
   *
   * That window is where Retry does its expensive work — discovery, load, structural validation —
   * and it is the only place a competing control can land to make the adoption stale.
   */
  readonly onArtifactResolve: (hook: (workflowKey: string) => Promise<void> | void) => void;
  readonly controls: ReturnType<typeof makeControls>;
  readonly waits: WaitResolver;
  readonly operations: WorkflowOperationServiceShape;
  readonly dispatcher: Dispatcher;
  /** The run as it is now. */
  readonly runOf: (runId: number) => Promise<WorkflowRunRecord>;
  /** Tear the incarnation down and build a fresh one over the same database. */
  readonly restart: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * The durable writes a test can crash.
 *
 * Mostly the commits that end a segment, plus `appendDiagnostic` — because a diagnostic that fails
 * to persist is its own failure mode, and the only honest way to test what happens next is to make
 * the write really fail.
 */
export type CommitName =
  | 'commitGraphEntry'
  | 'commitNodeResult'
  | 'commitRouting'
  | 'commitOutputMapping'
  | 'publishChildOutput'
  | 'completeRun'
  | 'enterSubgraph'
  | 'appendDiagnostic';

const commitNames = new Set<CommitName>([
  'commitGraphEntry',
  'commitNodeResult',
  'commitRouting',
  'commitOutputMapping',
  'publishChildOutput',
  'completeRun',
  'enterSubgraph',
  'appendDiagnostic',
]);

/** One independent environment: a project, a worktree and a surface inside it. */
export interface Placement {
  readonly worktreeId: number;
  readonly surfaceId: number;
}

interface RegisteredVersion {
  readonly artifactHash: string;
  readonly artifact: LoadedWorkflowArtifact;
}

export async function makeEngineHarness(): Promise<EngineHarness> {
  const fixture = makeWorkflowPersistenceFixture();
  const placement = fixture.seedPlacement();
  const failOnce = new Set<CommitName>();
  /**
   * A commit that fails once, which is how a crash is simulated honestly.
   *
   * The transaction raises and rolls back, so everything written *before* it — a captured producer
   * operand, a published payload — is exactly what a killed process would have left behind. Mocking
   * the recovery input instead would let a test assert against a durable state no crash can produce.
   */
  const runs = new Proxy(fixture.runs, {
    get(target, property: string) {
      const original = Reflect.get(target, property) as unknown;
      if (!commitNames.has(property as CommitName) || typeof original !== 'function') {
        return original;
      }
      return (...args: readonly unknown[]) => {
        if (!failOnce.delete(property as CommitName)) {
          return (original as (...a: readonly unknown[]) => unknown)(...args);
        }
        return Effect.fail(
          new DatabaseError({
            operation: property,
            cause: new Error(`simulated crash during ${property}`),
          }),
        );
      };
    },
  }) as WorkflowPersistenceFixture['runs'];
  const adapters = makeFakeAdapterState();
  const events: InternalRuntimeEvent[] = [];

  const versions = new Map<string, RegisteredVersion>();
  const current = new Map<string, string>();
  let beforeArmTimeReconcile: (waitId: number) => Promise<void> | void = () => {};
  let beforeArtifactResolve: (workflowKey: string) => Promise<void> | void = () => {};
  let brokenLoad: WorkflowLoadFailureReason | null = null;
  /**
   * A monotonic clock for the operation layer, shared across incarnations.
   *
   * Submission watermarks bound the search for the turn a prompt caused, so two watermarks landing
   * in the same millisecond would let a *later* wait match an *earlier* turn's edges — two candidate
   * starts, ambiguity, and an operation settled `uncertain` by an artefact of the fixture rather
   * than by anything the code did. Well-separated instants remove that entirely, and make a test
   * that fabricates a turn edge able to anchor it to exactly the submission it answers.
   */
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1) + tick++ * 60_000).toISOString();

  const keyOf = (workflowKey: string, version: string) => `${workflowKey}@${version}`;

  const publish: EngineHarness['publish'] = ({ workflowKey, version, definition }) => {
    const artifactHash = createHash('sha256').update(keyOf(workflowKey, version)).digest('hex');
    const artifact = describeWorkflowArtifact({ default: definition }, artifactHash, {
      workflowKey,
      artifactHash,
    });
    versions.set(keyOf(workflowKey, version), { artifactHash, artifact });
    versions.set(artifactHash, { artifactHash, artifact });
    if (!current.has(workflowKey)) current.set(workflowKey, version);
    seedArtifactRow(fixture, artifactHash, workflowKey, artifact.descriptor);
    return artifactHash;
  };

  const setCurrent: EngineHarness['setCurrent'] = (workflowKey, version) => {
    if (!versions.has(keyOf(workflowKey, version))) {
      throw new Error(`No registered version ${version} for workflow ${workflowKey}.`);
    }
    current.set(workflowKey, version);
  };

  const catalog: WorkflowArtifactCatalogService = {
    publish: ({ workflowKey }) => {
      const version = current.get(workflowKey);
      const registered = version ? versions.get(keyOf(workflowKey, version)) : undefined;
      return registered
        ? Effect.succeed(registered.artifact)
        : Effect.fail(
            new WorkflowLoadError({
              reason: 'missing_build',
              message: `No in-memory version registered for ${workflowKey}.`,
              workflowKey,
            }),
          );
    },
    loadPinned: ({ artifactHash, workflowKey }) => {
      const registered = versions.get(artifactHash);
      return registered
        ? Effect.succeed(registered.artifact)
        : Effect.fail(
            new WorkflowLoadError({
              reason: 'pinned_artifact_unavailable',
              message: `No in-memory artifact for pin ${artifactHash}.`,
              workflowKey,
              artifactHash,
            }),
          );
    },
    readDescriptor: (artifactHash) =>
      Effect.succeed(versions.get(artifactHash)?.artifact.descriptor ?? null),
    findRecord: (artifactHash) =>
      Effect.succeed(artifactRecordOf(versions.get(artifactHash) ?? null)),
  };

  const registry: WorkflowRegistryService = {
    discover: () =>
      Effect.succeed({
        entries: [...current.keys()].map((workflowKey) => ({ workflowKey })) as never,
        find: (workflowKey: string) =>
          (current.has(workflowKey) ? { workflowKey } : undefined) as never,
      }),
    loadDiscovered: (entry) => {
      const version = current.get(entry.workflowKey);
      const registered = version ? versions.get(keyOf(entry.workflowKey, version)) : undefined;
      return Effect.promise(async () => {
        await beforeArtifactResolve(entry.workflowKey);
      }).pipe(
        Effect.zipRight(
          Effect.suspend(() => {
            const reason = brokenLoad;
            brokenLoad = null;
            return reason === null
              ? Effect.void
              : Effect.fail(
                  new WorkflowLoadError({
                    reason,
                    message: `The verified build for ${entry.workflowKey} could not be loaded.`,
                    workflowKey: entry.workflowKey,
                  }),
                );
          }),
        ),
        Effect.zipRight(
          registered
            ? Effect.succeed(registered.artifact)
            : Effect.fail(
                new WorkflowLoadError({
                  reason: 'missing_build',
                  message: `No in-memory version registered for ${entry.workflowKey}.`,
                  workflowKey: entry.workflowKey,
                }),
              ),
        ),
      );
    },
    loadPinned: (artifactHash, workflowKey) =>
      catalog.loadPinned({ artifactHash, workflowKey }).pipe(Effect.orDie),
    addWorkflow: () => Effect.void,
  };

  const readers = placementReaders(fixture, placement);
  const workspace = readers.workspace;
  const surfaces = readers.surfaceRepository;
  const launchDeps: LaunchDeps = {
    runs,
    registry,
    catalog,
    workspace: workspace as never,
    surfaces: readers.surfaceService as never,
    // Launch-scoped, and deliberately not the dispatcher's identity: launch claims and holds the
    // preparation segment itself, so the two never contend for the same attempt.
    owner: 'workflow-launch:test',
    ownerIncarnation: 'incarnation:test',
  };

  let incarnation = await buildIncarnation();
  async function buildIncarnation() {
    const scope = await Effect.runPromise(Scope.make());
    const eventBus = {
      publish: (event: InternalRuntimeEvent) =>
        Effect.sync(() => {
          events.push(event);
        }),
      subscribe: () =>
        Effect.succeed({
          take: Effect.never as Effect.Effect<InternalRuntimeEvent>,
          unsubscribe: Effect.void,
        }),
    };
    const operations = await Effect.runPromise(
      Scope.extend(
        makeWorkflowOperationService({
          operations: fixture.operations,
          runs,
          payloads: fixture.payloads,
          adapters: makeFakeAdapters(adapters),
          eventBus,
          now,
        }),
        scope,
      ),
    );
    const waits = makeWaitResolver({
      runs,
      payloads: fixture.payloads,
      operationRecords: fixture.operations,
      operations,
      catalog,
      turnEdges: (agentSessionId) => Effect.succeed(adapters.turnEdges.get(agentSessionId) ?? []),
    });
    const dispatcher = makeDispatcher({
      runs,
      payloads: fixture.payloads,
      operations,
      operationRecords: fixture.operations,
      catalog,
      owner: `worker:${Math.random().toString(16).slice(2)}`,
      ownerIncarnation: operations.incarnationId,
      reconcileExecution: operations.reconcileExecution,
      // The production resolver, reached through the production call path. The hook only lets a test
      // put something *into* the window between the suspend committing and this running — which is
      // the only way to observe a race that is otherwise a few microseconds wide.
      reconcileWait: (waitId) =>
        Effect.promise(async () => {
          await beforeArmTimeReconcile(waitId);
        }).pipe(Effect.zipRight(waits.reconcileWait(waitId))),
    });
    const controls = makeControls({
      ...launchDeps,
      payloads: fixture.payloads,
      operationRecords: fixture.operations,
      operations,
      waits,
      poke: Effect.void,
    });
    return { scope, operations, waits, dispatcher, controls };
  }

  /**
   * The wake queue's stand-in: drain until nothing moves.
   *
   * It deliberately does **not** resolve waits. An earlier version did, and that compensation hid a
   * real gap — the engine was not re-checking a wait at the moment it armed it, so a receipt that
   * arrived before the wait existed was never noticed in production while every test still passed.
   * Delivery now happens where it happens in production: at arm time, or when an event reaches the
   * resolver, which a test triggers explicitly through `deliver`.
   */
  const drain = async () => {
    let total = 0;
    for (let pass = 0; pass < 50; pass += 1) {
      const summary = await run(incarnation.dispatcher.drainOnce);
      total += summary.advanced;
      if (summary.advanced === 0) break;
    }
    return total;
  };

  return {
    fixture,
    adapters,
    events,
    placement,
    seedPlacement: () => fixture.seedPlacement(),
    publish,
    setCurrent,
    crashNext: (commit) => {
      failOnce.add(commit);
    },
    breakNextLoad: (reason = 'stale_source') => {
      brokenLoad = reason;
    },
    launch: async ({ workflowKey, inputs, placement: target }) =>
      run(
        startWorkflow(launchDeps, {
          workflowKey,
          inputs: inputs ?? {},
          origin: {
            worktreeId: (target ?? placement).worktreeId,
            surfaceId: (target ?? placement).surfaceId,
          },
        }),
      ),
    launchExit: ({ workflowKey, inputs, origin }) =>
      Effect.runPromiseExit(
        startWorkflow(launchDeps, {
          workflowKey,
          inputs: inputs ?? {},
          origin: origin ?? { worktreeId: placement.worktreeId, surfaceId: placement.surfaceId },
        }),
      ),
    drain,
    deliver: (runId) => run(incarnation.waits.reconcileWaits(runId)),
    settleOperation: async ({ operationId, state, result }) => {
      const settled = await run(
        fixture.operations.settle({
          operationId,
          state,
          ...(result === undefined ? {} : { result: { value: result } }),
        }),
      );
      if (!settled.ok) return;
      events.push({
        type: 'workflow_operation_settled',
        runId: settled.value.runId,
        operationId: settled.value.id,
        operationKey: settled.value.operationKey,
      });
    },
    onArmTimeReconcile: (hook) => {
      beforeArmTimeReconcile = hook;
    },
    onArtifactResolve: (hook) => {
      beforeArtifactResolve = hook;
    },
    get controls() {
      return incarnation.controls;
    },
    get waits() {
      return incarnation.waits;
    },
    get operations() {
      return incarnation.operations;
    },
    get dispatcher() {
      return incarnation.dispatcher;
    },
    runOf: async (runId) => (await run(fixture.runs.findRun(runId)))!,
    restart: async () => {
      await Effect.runPromise(Scope.close(incarnation.scope, Exit.void));
      incarnation = await buildIncarnation();
      await run(
        recoverAtStartup({
          runs,
          workspace: workspace as never,
          surfaces: surfaces as never,
          eventBus: {
            publish: () => Effect.void,
            subscribe: () =>
              Effect.succeed({
                take: Effect.never as Effect.Effect<InternalRuntimeEvent>,
                unsubscribe: Effect.void,
              }),
          },
          operations: incarnation.operations,
          waits: incarnation.waits,
        }),
      );
    },
    close: async () => {
      await Effect.runPromise(Scope.close(incarnation.scope, Exit.void));
      fixture.close();
    },
  };
}

/**
 * Readers over the placement rows the engine consults, narrowed to the fields it actually reads.
 *
 * Not fakes: every answer comes from the real `projects`, `worktrees` and `worktree_surfaces` rows
 * in the database under test. The production services own far more than the engine needs — sessions,
 * panes, Git, PTYs — and standing all of that up would make the placement facts harder to see, not
 * more real. Exported so the authoring proof composes the same readers rather than a second
 * approximation of them.
 */
export function placementReaders(fixture: WorkflowPersistenceFixture, placement: Placement) {
  return {
    workspace: workspaceReader(fixture, placement),
    surfaceRepository: surfaceReader(fixture, placement),
    surfaceService: surfaceDetailReader(fixture),
  };
}

function workspaceReader(fixture: WorkflowPersistenceFixture, placement: Placement) {
  return {
    findWorktree: (worktreeId: number) =>
      Effect.sync(() => {
        const row = fixture.client
          .prepare('SELECT id, project_id AS projectId, path FROM worktrees WHERE id = ?')
          .get(worktreeId) as { id: number; projectId: number; path: string } | undefined;
        return row ?? null;
      }),
    findProject: (projectId: number) =>
      Effect.sync(() => {
        const row = fixture.client
          .prepare('SELECT id, root_path AS rootPath FROM projects WHERE id = ?')
          .get(projectId) as { id: number; rootPath: string } | undefined;
        return row ?? null;
      }),
    placement,
  };
}

function surfaceReader(fixture: WorkflowPersistenceFixture, placement: Placement) {
  return {
    findSurface: (surfaceId: number) =>
      Effect.sync(() => {
        const row = fixture.client
          .prepare('SELECT id, worktree_id AS worktreeId FROM worktree_surfaces WHERE id = ?')
          .get(surfaceId) as { id: number; worktreeId: number } | undefined;
        return row ?? null;
      }),
    placement,
  };
}

/**
 * Surface detail read from the real rows rather than assumed.
 *
 * It matters for more than multi-environment tests: the launch path rejects a surface that belongs
 * to another worktree, and a reader that echoed back whatever worktree it was constructed with could
 * never produce that mismatch.
 */
function surfaceDetailReader(fixture: WorkflowPersistenceFixture) {
  return {
    getSurfaceDetail: (surfaceId: number) =>
      Effect.suspend(() => {
        const row = fixture.client
          .prepare('SELECT id, worktree_id AS worktreeId FROM worktree_surfaces WHERE id = ?')
          .get(surfaceId) as { id: number; worktreeId: number } | undefined;
        return row
          ? Effect.succeed({ id: row.id, worktreeId: row.worktreeId, panes: [] })
          : Effect.fail(new Error(`Surface ${surfaceId} was not found.`));
      }),
  };
}

function seedArtifactRow(
  fixture: WorkflowPersistenceFixture,
  artifactHash: string,
  workflowKey: string,
  descriptor: WorkflowStructureDescriptor,
) {
  fixture.client
    .prepare(
      `INSERT OR IGNORE INTO workflow_artifacts (
         artifact_hash, workflow_key, contract_version, manifest_version, descriptor_version,
         sdk_version, verifier_version, source_hash, structure_hash, root_graph_key,
         descriptor_inline, first_seen_at
       ) VALUES (?, ?, 2, 2, 1, '0.1.0', '0.1.0', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(
      artifactHash,
      workflowKey,
      createHash('sha256').update(artifactHash).digest('hex'),
      createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
      descriptor.rootGraphKey,
      JSON.stringify(descriptor),
    );
}

function artifactRecordOf(registered: RegisteredVersion | null): WorkflowArtifactRecord | null {
  if (!registered) return null;
  return {
    artifactHash: registered.artifactHash,
    workflowKey: registered.artifact.descriptor.rootGraphKey,
    contractVersion: 2,
    manifestVersion: 2,
    descriptorVersion: 1,
    sdkVersion: '0.1.0',
    verifierVersion: '0.1.0',
    sourceHash: registered.artifactHash,
    structureHash: registered.artifactHash,
    rootGraphKey: registered.artifact.descriptor.rootGraphKey,
    descriptor: { inline: JSON.stringify(registered.artifact.descriptor), ref: null },
    firstSeenAt: '2026-01-01T00:00:00.000Z',
  };
}
