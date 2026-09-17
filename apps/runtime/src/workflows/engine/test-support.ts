import { createHash } from 'node:crypto';

import type { WorkflowStructureDescriptor } from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { Effect, Exit, Scope } from 'effect';

import type {
  OpenWorktreeInput,
  OpenWorktreeOutput,
  WorkflowLoadFailureReason,
  WorkflowPlacementRequestDto,
  WorktreeSetupResult,
} from '@isagi/contracts';

import { DatabaseError } from '../../persistence/index.js';
import type { InternalRuntimeEvent } from '../../runtime-events/internal-event-bus.js';
import { duplicateSafeTitle, SurfaceError, validateSurfaceTitle } from '../../surfaces/index.js';
import type {
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
} from '../../surfaces/index.js';
import type { SurfaceServiceError } from '../../surfaces/surfaces.service.js';
import { WorkspaceError, type WorkspaceServiceError } from '../../workspace/workspace.service.js';
import {
  makeWorkflowOperationService,
  type WorkflowOperationServiceShape,
} from '../operations/operation.service.js';
import {
  makeFakeAdapters,
  makeFakeAdapterState,
  type FakeAdapterState,
} from '../operations/test-support.js';
import type {
  WorkflowArtifactRecord,
  WorkflowRunPreparationRecord,
  WorkflowRunRecord,
} from '../persistence/records.js';
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
import { prepareEnvironment } from './environment/preparation.js';
import type { PreparationContext, PreparationDeps } from './environment/types.js';
import { startWorkflow, type LaunchDeps } from './launch.js';
import { recoverAtStartup } from './recovery.js';
import type { SegmentOutcome } from './segments/shared.js';

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
  /**
   * Make a call to one named commit fail and roll back, exactly as a crash would.
   *
   * `skip` lets the first N calls through first, which is how a test lands a crash *between* two
   * writes that share a name — preparation's three receipts being the case that needs it.
   */
  readonly crashNext: (commit: CommitName, skip?: number) => void;
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
    /** A caller override, exactly as the start request carries one. */
    readonly request?: WorkflowPlacementRequestDto;
  }) => Promise<WorkflowRunRecord>;
  /** Launch without unwrapping the failure, for the rejections that must leave no run behind. */
  readonly launchExit: (input: {
    readonly workflowKey: string;
    readonly inputs?: Record<string, unknown>;
    readonly origin?: { readonly worktreeId: number; readonly surfaceId: number };
    readonly request?: WorkflowPlacementRequestDto;
  }) => Promise<Exit.Exit<WorkflowRunRecord, unknown>>;
  /** The owning-service seam: the doubles, the call log, and the deletions log that must stay empty. */
  readonly owning: ReturnType<typeof owningServices>;
  /** The durable preparation record: what was requested, and what this launch actually allocated. */
  readonly preparationOf: (runId: number) => Promise<WorkflowRunPreparationRecord | null>;
  /**
   * Re-enters preparation the way Retry will, through the real transactions.
   *
   * **Phase 08 owns the real control, and owns re-pointing every caller of this at it.** The
   * sequence below is deliberately the one `controls.retry` will perform at this position — adopt
   * the pin against the failed position and a released owner, re-read, claim with the recorded
   * decision and its receipts — minus the artifact re-resolution, which belongs to the control and
   * not to the segment. A helper that quietly diverges from the control it stands in for is the
   * failure this note exists to prevent: when phase 08 lands, confirm the two match and delete this.
   */
  readonly retryPreparation: (runId: number) => Promise<SegmentOutcome>;
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
  | 'recordEnvironmentReceipt'
  | 'commitEnvironmentPreparation'
  | 'commitGraphEntry'
  | 'commitNodeResult'
  | 'commitRouting'
  | 'commitOutputMapping'
  | 'publishChildOutput'
  | 'completeRun'
  | 'enterSubgraph'
  | 'appendDiagnostic';

const commitNames = new Set<CommitName>([
  'recordEnvironmentReceipt',
  'commitEnvironmentPreparation',
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
  /**
   * Which write to crash, and how many of its calls to let through first.
   *
   * The skip count exists for preparation: its receipts are three separate transactions under one
   * name, and "crashed between the worktree receipt and the setup receipt" is a materially
   * different durable state from "crashed before either" — one leaves a worktree nothing owns a
   * record of, the other leaves a retry that must reuse it.
   */
  const failOnce = new Map<CommitName, number>();
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
        const name = property as CommitName;
        const remaining = failOnce.get(name);
        if (remaining === undefined) {
          return (original as (...a: readonly unknown[]) => unknown)(...args);
        }
        if (remaining > 0) {
          failOnce.set(name, remaining - 1);
          return (original as (...a: readonly unknown[]) => unknown)(...args);
        }
        failOnce.delete(name);
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
  const owning = owningServices(fixture);
  const workspace = readers.workspace;
  const surfaces = readers.surfaceRepository;
  const launchDeps: LaunchDeps = {
    runs,
    registry,
    catalog,
    workspace: workspace as never,
    workspaceService: owning.workspaceService as never,
    surfaceRepository: readers.surfaceRepository as never,
    surfaces: {
      ...readers.surfaceService,
      createSinglePaneSurface: owning.createSinglePaneSurface,
    } as never,
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
   * The same preparation `interpreter.service.ts` runs, over the same dependencies.
   *
   * One deliberate divergence: production forks into the engine scope and joins the fiber, while
   * this runs inline. Join semantics are identical when nothing interrupts, and neither binding
   * covers shutdown interruption — so forking here would buy no assertion and cost a closure over
   * mutable incarnation state plus nondeterministic scheduling in every engine test.
   */
  const prepDeps: PreparationDeps = {
    runs,
    workspace: workspace as never,
    workspaceService: owning.workspaceService as never,
    surfaceRepository: readers.surfaceRepository as never,
    surfaces: { createSinglePaneSurface: owning.createSinglePaneSurface } as never,
    owner: launchDeps.owner,
    ownerIncarnation: launchDeps.ownerIncarnation,
    poke: Effect.void,
  };
  const runPreparation = (ctx: PreparationContext) => prepareEnvironment(prepDeps, ctx);

  const launched = (input: {
    readonly workflowKey: string;
    readonly inputs?: Record<string, unknown> | undefined;
    readonly origin: { readonly worktreeId: number; readonly surfaceId: number };
    readonly placement?: Parameters<typeof startWorkflow>[1]['placement'];
  }) =>
    startWorkflow(launchDeps, {
      workflowKey: input.workflowKey,
      inputs: input.inputs ?? {},
      origin: input.origin,
      ...(input.placement === undefined ? {} : { placement: input.placement }),
    }).pipe(
      Effect.tap(runPreparation),
      // Re-read rather than returned from the create: the destination, position and ownership all
      // moved in the commit, and handing back the pre-commit record would describe a run that no
      // longer exists.
      Effect.flatMap(({ run: created }) =>
        runs.findRun(created.id).pipe(Effect.map((placed) => placed ?? created)),
      ),
    );

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
    crashNext: (commit, skip = 0) => {
      failOnce.set(commit, skip);
    },
    breakNextLoad: (reason = 'stale_source') => {
      brokenLoad = reason;
    },
    launch: async ({ workflowKey, inputs, placement: target, request }) =>
      run(
        launched({
          workflowKey,
          inputs,
          origin: {
            worktreeId: (target ?? placement).worktreeId,
            surfaceId: (target ?? placement).surfaceId,
          },
          ...(request === undefined ? {} : { placement: request }),
        }),
      ),
    launchExit: ({ workflowKey, inputs, origin, request }) =>
      Effect.runPromiseExit(
        launched({
          workflowKey,
          inputs,
          origin: origin ?? { worktreeId: placement.worktreeId, surfaceId: placement.surfaceId },
          ...(request === undefined ? {} : { placement: request }),
        }),
      ),
    owning,
    preparationOf: (runId) => run(fixture.runs.findPreparation(runId)),
    retryPreparation: async (runId) => {
      const failed = (await run(fixture.runs.findRun(runId)))!;
      const adopted = await run(
        fixture.runs.adoptRetryPin({
          runId,
          controlRevision: failed.controlRevision,
          artifactHash: failed.artifactHash,
          expectedPosition: failed.position,
          // A failed run has already released ownership, which is what makes the pin adoptable.
          expectedOwner: null,
        }),
      );
      if (!adopted.ok) throw new Error(`Retry pin was refused: ${adopted.rejection.kind}`);
      const repinned = (await run(fixture.runs.findRun(runId)))!;
      const prep = await run(fixture.runs.findPreparation(runId));
      const claimed = await run(
        fixture.runs.claimSegment({
          runId,
          controlRevision: repinned.controlRevision,
          owner: launchDeps.owner,
          ownerIncarnation: launchDeps.ownerIncarnation,
          input: {
            value: {
              segment: 'environment_preparation',
              source: prep?.source ?? null,
              request: prep?.request ?? null,
              baseCommit: prep?.baseCommit ?? null,
              checkoutPath: prep?.checkoutPath ?? null,
              receipts: {
                worktree: prep?.worktree ?? null,
                setup: prep?.setup ?? null,
                surface: prep?.surface ?? null,
              },
            },
          },
          preparation: {
            position: repinned.position,
            artifactHash: repinned.artifactHash,
            frameStates: [],
          },
        }),
      );
      if (!claimed.ok) throw new Error(`Retry claim was refused: ${claimed.rejection.kind}`);
      return run(runPreparation({ run: claimed.value.run, attempt: claimed.value.attempt }));
    },
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

/**
 * The owning-service seam: what preparation is allowed to mutate, and the log that proves what it did.
 *
 * Every allocating operation **dies by default**. That is what keeps phase 06's guarantee structural
 * rather than conventional: no launch-path rejection may reach a service that creates, and one that
 * does says so loudly instead of quietly succeeding. A preparation test opts each operation in by
 * name, which also makes the opt-in itself readable — a test that never calls `allowsWorktrees()`
 * is asserting that no worktree was ever created.
 *
 * What the enabled operations then do is **write real rows**, not return plausible shapes. A
 * `findWorktree` after a creation has to find the worktree, a keyed surface re-entry has to resolve
 * through the real `creation_key` column, and a second creation on the same branch has to collide —
 * none of which a fabricated return value can produce.
 */
export function owningServices(fixture: WorkflowPersistenceFixture) {
  const calls: string[] = [];
  /**
   * Every destructive operation anyone asked for.
   *
   * Preparation deliberately has no deletion in its dependency surface, so this can only ever be
   * populated by a future widening — which is exactly the regression the "nothing is deleted on any
   * failure path" rule exists to prevent. Asserted empty on every failure route.
   */
  const deletions: string[] = [];

  let preflight: (input: {
    readonly projectId: number;
    readonly branch: string;
    readonly fromRef: string;
  }) => Effect.Effect<{ commit: string; checkoutPath: string }, WorkspaceServiceError> = (input) =>
    Effect.succeed({
      commit: 'a'.repeat(40),
      checkoutPath: derivedCheckoutPath(input.projectId, input.branch),
    });

  const allocating =
    (name: string) =>
    (...args: readonly unknown[]) => {
      calls.push(name);
      void args;
      return Effect.die(new Error(`${name} must not be reached unless a test allows it.`));
    };

  let openWorktree: (input: {
    readonly projectId: number;
    readonly request: OpenWorktreeInput;
  }) => Effect.Effect<OpenWorktreeOutput, WorkspaceServiceError> = allocating('openWorktree');

  let runWorktreeSetup: (input: {
    readonly projectId: number;
    readonly worktreeId: number;
  }) => Effect.Effect<Exclude<WorktreeSetupResult, { status: 'not_run' }>, WorkspaceServiceError> =
    allocating('runWorktreeSetup');

  let createSinglePaneSurface: (
    input: CreateSinglePaneSurfaceInput,
  ) => Effect.Effect<CreateSinglePaneSurfaceOutput, SurfaceServiceError> =
    allocating('createSinglePaneSurface');

  /**
   * Worktree creation that really creates, and really collides.
   *
   * It mirrors the two decisions of `openWorktree` that preparation depends on: `create_new`
   * refuses a branch this project already has a worktree for, with the same `worktree_exists` error
   * carrying the same identities — which is what the adoption predicate is then asked to judge —
   * and a successful creation inserts a row at Isagi's derived checkout path, so the path the
   * preflight recorded and the path the row reports are the same string for the same reason they
   * are in production.
   */
  const allowsWorktrees = (options?: {
    readonly setup?: Exclude<WorktreeSetupResult, { status: 'not_run' }> | undefined;
  }) => {
    openWorktree = (input) =>
      Effect.suspend(() => {
        calls.push('openWorktree');
        const branch = input.request.branch.trim();
        const existing = fixture.client
          .prepare('SELECT id, path FROM worktrees WHERE project_id = ? AND branch = ?')
          .get(input.projectId, branch) as { id: number; path: string } | undefined;
        if (existing && input.request.mode === 'create_new') {
          return Effect.fail(
            new WorkspaceError({
              branch,
              code: 'worktree_exists',
              message: `Worktree ${existing.id} is already checked out on branch ${branch}.`,
              path: existing.path,
              projectId: input.projectId,
              worktreeId: existing.id,
            }),
          );
        }
        const worktreeId = seedWorktreeRow(fixture, {
          projectId: input.projectId,
          branch,
          path: derivedCheckoutPath(input.projectId, branch),
        });
        const setup = options?.setup ?? ({ status: 'skipped', reason: 'not_configured' } as const);
        return Effect.succeed(
          (setup.status === 'failed'
            ? {
                projectId: input.projectId,
                worktreeId,
                branch,
                status: 'created_setup_failed',
                setup,
              }
            : {
                projectId: input.projectId,
                worktreeId,
                branch,
                status: 'created',
                setup,
              }) as OpenWorktreeOutput,
        );
      });
    return api;
  };

  const allowsSetup = (
    result: Exclude<WorktreeSetupResult, { status: 'not_run' }> = {
      status: 'succeeded',
      runId: 1,
    },
  ) => {
    runWorktreeSetup = () =>
      Effect.suspend(() => {
        calls.push('runWorktreeSetup');
        return Effect.succeed(result);
      });
    return api;
  };

  /**
   * Surface creation through the real rows, key and all.
   *
   * `creation_key` is the whole reason this cannot be a stub: re-entry after a crash between the
   * insert and its receipt has to resolve *the same surface*, and only the real column can decide
   * that. The title goes through the same `validateSurfaceTitle` and `duplicateSafeTitle` the
   * service uses, so a duplicate title is rewritten here exactly as it would be in production.
   */
  const allowsSurfaces = () => {
    createSinglePaneSurface = (input) =>
      Effect.suspend(() => {
        calls.push('createSinglePaneSurface');
        const worktree = fixture.client
          .prepare('SELECT id, path FROM worktrees WHERE id = ?')
          .get(input.worktreeId) as { id: number; path: string } | undefined;
        if (!worktree) {
          return Effect.fail(
            new SurfaceError({
              code: 'worktree_not_found',
              message: `Worktree ${input.worktreeId} was not found.`,
              worktreeId: input.worktreeId,
            }),
          );
        }
        const created = (
          titleBase: string,
        ): Effect.Effect<CreateSinglePaneSurfaceOutput, SurfaceServiceError> =>
          Effect.suspend(() => {
            if (input.creationKey !== undefined) {
              const keyed = fixture.client
                .prepare(
                  `SELECT s.id AS surfaceId, s.worktree_id AS worktreeId, s.title AS title,
                          (SELECT p.id FROM surface_panes p WHERE p.surface_id = s.id ORDER BY p.id LIMIT 1) AS paneId
                     FROM worktree_surfaces s WHERE s.creation_key = ?`,
                )
                .get(input.creationKey) as
                | { surfaceId: number; worktreeId: number; title: string; paneId: number }
                | undefined;
              if (keyed) {
                return keyed.worktreeId === input.worktreeId
                  ? Effect.succeed({
                      surfaceId: keyed.surfaceId,
                      paneId: keyed.paneId,
                      title: keyed.title,
                      cwd: worktree.path,
                    })
                  : Effect.fail(
                      new SurfaceError({
                        code: 'creation_key_mismatch',
                        message: `Creation key ${input.creationKey} already names surface ${keyed.surfaceId} on worktree ${keyed.worktreeId}.`,
                        surfaceId: keyed.surfaceId,
                        worktreeId: keyed.worktreeId,
                      }),
                    );
              }
            }
            const siblings = fixture.client
              .prepare(
                'SELECT title, sort_order AS sortOrder FROM worktree_surfaces WHERE worktree_id = ?',
              )
              .all(input.worktreeId) as { title: string; sortOrder: number }[];
            const title = duplicateSafeTitle(
              titleBase,
              siblings.map((sibling) => sibling.title),
            );
            const now = new Date().toISOString();
            const surface = fixture.client
              .prepare(
                `INSERT INTO worktree_surfaces (worktree_id, title, layout_json, sort_order, creation_key, created_at, updated_at)
                 VALUES (?, ?, '{}', ?, ?, ?, ?)`,
              )
              .run(
                input.worktreeId,
                title,
                siblings.reduce((max, sibling) => Math.max(max, sibling.sortOrder), -1) + 1,
                input.creationKey ?? null,
                now,
                now,
              );
            const pane = fixture.client
              .prepare(
                `INSERT INTO surface_panes (surface_id, title, sort_order, session_kind, session_id, created_at, updated_at)
                 VALUES (?, ?, 0, NULL, NULL, ?, ?)`,
              )
              .run(Number(surface.lastInsertRowid), title, now, now);
            return Effect.succeed({
              surfaceId: Number(surface.lastInsertRowid),
              paneId: Number(pane.lastInsertRowid),
              title,
              cwd: worktree.path,
            });
          });
        return validateSurfaceTitle(input.titleBase).pipe(Effect.flatMap(created));
      });
    return api;
  };

  const api = {
    /** Every call, allocating or not. A rejection test asserts this is exactly what it expects. */
    calls,
    deletions,
    setPreflight: (handler: typeof preflight) => void (preflight = handler),
    setOpenWorktree: (handler: typeof openWorktree) => void (openWorktree = handler),
    /**
     * Wraps whatever creator is currently installed.
     *
     * Deliberately handed the installed implementation rather than the service method: the method
     * dispatches through the mutable slot this replaces, so a wrapper that called it would call
     * itself. Tests use this to observe the window *inside* an allocation — what the preparation
     * row held while the worktree was being made, or a Cancel landing between the two.
     */
    wrapOpenWorktree: (wrap: (inner: typeof openWorktree) => typeof openWorktree) => {
      const inner = openWorktree;
      openWorktree = wrap(inner);
    },
    setRunWorktreeSetup: (handler: typeof runWorktreeSetup) => void (runWorktreeSetup = handler),
    allowsWorktrees,
    allowsSetup,
    allowsSurfaces,
    workspaceService: {
      preflightWorktreeCreation: (input: {
        readonly projectId: number;
        readonly branch: string;
        readonly fromRef: string;
      }) =>
        Effect.suspend(() => {
          calls.push('preflightWorktreeCreation');
          return preflight(input);
        }),
      openWorktree: (input: { readonly projectId: number; readonly request: OpenWorktreeInput }) =>
        Effect.suspend(() => openWorktree(input)),
      runWorktreeSetup: (input: { readonly projectId: number; readonly worktreeId: number }) =>
        Effect.suspend(() => runWorktreeSetup(input)),
      deleteWorktree: (...args: readonly unknown[]) => {
        deletions.push('deleteWorktree');
        void args;
        return Effect.die(new Error('Preparation must never delete a worktree.'));
      },
    },
    createSinglePaneSurface: (input: CreateSinglePaneSurfaceInput) =>
      Effect.suspend(() => createSinglePaneSurface(input)),
    deleteSurface: (...args: readonly unknown[]) => {
      deletions.push('deleteSurface');
      void args;
      return Effect.die(new Error('Preparation must never delete a surface.'));
    },
  };
  return api;
}

/** The checkout path Isagi derives for a branch, as both the preflight and the creator see it. */
export function derivedCheckoutPath(projectId: number, branch: string): string {
  return `/isagi/worktrees/${projectId}/${branch}`;
}

/**
 * Inserts a worktree row the way reconciliation would, and returns its id.
 *
 * Exported because two very different things need it: the creation fake above, and the tests that
 * stage an *interrupted* creation — a real checkout Git holds with no receipt naming it — which is
 * the state the adoption predicate exists to judge.
 */
export function seedWorktreeRow(
  fixture: WorkflowPersistenceFixture,
  input: {
    readonly projectId: number;
    readonly branch: string;
    readonly path: string;
    readonly firstSeenAt?: string | undefined;
  },
): number {
  const now = new Date().toISOString();
  const inserted = fixture.client
    .prepare(
      `INSERT INTO worktrees (project_id, path, branch, head, sort_order, created_at, updated_at, first_seen_at)
       VALUES (?, ?, ?, NULL, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM worktrees WHERE project_id = ?), ?, ?, ?)`,
    )
    .run(
      input.projectId,
      input.path,
      input.branch,
      input.projectId,
      now,
      now,
      input.firstSeenAt ?? now,
    );
  return Number(inserted.lastInsertRowid);
}

function workspaceReader(fixture: WorkflowPersistenceFixture, placement: Placement) {
  return {
    findWorktree: (worktreeId: number) =>
      Effect.sync(() => {
        const row = fixture.client
          .prepare(
            'SELECT id, project_id AS projectId, path, branch, head FROM worktrees WHERE id = ?',
          )
          .get(worktreeId) as
          | {
              id: number;
              projectId: number;
              path: string;
              branch: string | null;
              head: string | null;
            }
          | undefined;
        return row ?? null;
      }),
    findProject: (projectId: number) =>
      Effect.sync(() => {
        const row = fixture.client
          .prepare('SELECT id, name, kind, root_path AS rootPath FROM projects WHERE id = ?')
          .get(projectId) as
          | { id: number; name: string; kind: 'git' | 'folder'; rootPath: string }
          | undefined;
        return row ?? null;
      }),
    /**
     * The worktree a project has on a branch, which is what the adoption predicate asks for.
     *
     * Selected rather than derived from `listWorktrees` for the same reason production does: one
     * indexed read, and the `first_seen_at` the predicate compares is a column, not a guess.
     */
    findProjectWorktreeByBranch: (input: { readonly projectId: number; readonly branch: string }) =>
      Effect.sync(() => {
        const row = fixture.client
          .prepare(
            `SELECT id, project_id AS projectId, path, branch, head, first_seen_at AS firstSeenAt
               FROM worktrees WHERE project_id = ? AND branch = ?`,
          )
          .get(input.projectId, input.branch) as
          | {
              id: number;
              projectId: number;
              path: string;
              branch: string | null;
              head: string | null;
              firstSeenAt: string;
            }
          | undefined;
        return row ?? null;
      }),
    /** Every worktree in the database. Discovery does the project filtering, as it does in production. */
    listWorktrees: Effect.sync(
      () =>
        fixture.client
          .prepare(
            'SELECT id, project_id AS projectId, path, branch, head FROM worktrees ORDER BY id',
          )
          .all() as readonly {
          id: number;
          projectId: number;
          path: string;
          branch: string | null;
          head: string | null;
        }[],
    ),
    placement,
  };
}

function surfaceReader(fixture: WorkflowPersistenceFixture, placement: Placement) {
  return {
    findSurface: (surfaceId: number) =>
      Effect.sync(() => {
        const row = fixture.client
          .prepare(
            'SELECT id, worktree_id AS worktreeId, title FROM worktree_surfaces WHERE id = ?',
          )
          .get(surfaceId) as { id: number; worktreeId: number; title: string } | undefined;
        return row ?? null;
      }),
    listWorkspaceSurfaceMetadata: Effect.sync(
      () =>
        fixture.client
          .prepare(
            'SELECT id, worktree_id AS worktreeId, title FROM worktree_surfaces ORDER BY worktree_id, id',
          )
          .all() as readonly { id: number; worktreeId: number; title: string }[],
    ),
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
