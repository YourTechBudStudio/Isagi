import { Effect } from 'effect';

import type { PayloadSlot } from '../persistence/payload-store.js';
import type { WorkflowRunRecord } from '../persistence/records.js';
import { encodeRunPosition } from '../persistence/row-mappers.js';
import type { ClaimPreparation } from '../persistence/runs.repository.js';
import type { WorkflowArtifactCatalogService } from '../structure/artifact-catalog.js';
import type { LoadedWorkflowArtifact } from '../structure/loader.js';
import {
  isAgentTurnEvent,
  recoveryWaitDeclaration,
  type AttemptTurnRecovery,
} from '../waits/turn-recovery.js';
import { runGraphEntry } from './segments/graph-entry.js';
import { runGraphOutput } from './segments/graph-output.js';
import { runNodeCallback } from './segments/node-callback.js';
import { runOutputMapping } from './segments/output-mapping.js';
import { runRouting } from './segments/routing.js';
import {
  advanced,
  halted,
  resolveSlot,
  type EngineDeps,
  type SegmentContext,
  type SegmentFault,
  type SegmentOutcome,
} from './segments/shared.js';
import { nodeOf } from './structure.js';

/**
 * The single worker that advances runs, one segment at a time.
 *
 * Wake-driven with no steady-state poll, and it drains to empty rather than trusting that it was
 * woken for every change: a notification is a hint, and correctness comes from the durable set of
 * dispatchable runs. Running exactly one segment per claim — rather than looping inside a claim —
 * keeps every control check at a real boundary and keeps the claim window short.
 */
export interface Dispatcher {
  /**
   * Advance every dispatchable run until none moves.
   *
   * A persistence fault while listing is surfaced rather than swallowed: the caller decides whether
   * a drain it cannot even start is worth logging or worth stopping for. Per-run faults are already
   * handled inside, because one broken run must not stop the others.
   */
  readonly drainOnce: Effect.Effect<DrainSummary, SegmentFault>;
  readonly advanceRun: (runId: number) => Effect.Effect<SegmentOutcome, SegmentFault>;
}

export interface DrainSummary {
  readonly advanced: number;
  readonly passes: number;
  /**
   * True when the drain stopped at its pass limit with work still available.
   *
   * The limit exists so one run cannot monopolize the single worker — nothing bounds an author's
   * loop for them, and a graph that routes onward forever is a legitimate thing to write. Reporting
   * it lets the caller wake the worker again rather than leaving the remaining runs stalled until
   * some unrelated event happens to arrive.
   */
  readonly exhausted: boolean;
}

/** How many segments one drain will run before yielding, so no single run starves the others. */
const drainPassLimit = 1000;

export interface DispatcherDeps extends EngineDeps {
  readonly catalog: WorkflowArtifactCatalogService;
  /**
   * Settles what can be settled before a callback is re-entered.
   *
   * Called *before* the claim, not after. Reconciliation can block a run on an uncertain operation,
   * and blocking after an attempt was allocated would leave the run holding a claim it must not
   * use — or, worse, have the resulting segment failure overwrite `blocked` with `failed`. Asking
   * first means an unresolvable execution simply never becomes dispatchable.
   */
  readonly reconcileExecution: (
    executionId: number,
  ) => Effect.Effect<{ readonly uncertainOperationId: number | null }>;
}

export function makeDispatcher(deps: DispatcherDeps): Dispatcher {
  const advanceRun = (runId: number): Effect.Effect<SegmentOutcome, SegmentFault> =>
    Effect.gen(function* () {
      const run = yield* deps.runs.findRun(runId);
      if (!run) return halted('run_not_found');
      return yield* advance(deps, run);
    });

  const drainOnce: Effect.Effect<DrainSummary, SegmentFault> = Effect.gen(function* () {
    let total = 0;
    let passes = 0;
    let exhausted = false;
    for (let pass = 0; pass < drainPassLimit; pass += 1) {
      passes = pass + 1;
      const runs = yield* deps.runs.listDispatchable();
      if (runs.length === 0) break;
      // Every dispatchable run advances one segment per pass, so a long-running graph interleaves
      // with the others rather than holding the worker until it finishes.
      if (pass === drainPassLimit - 1) exhausted = true;
      let moved = 0;
      for (const run of runs) {
        const outcome = yield* advance(deps, run).pipe(
          Effect.catchAll((fault) =>
            Effect.sync(() => {
              console.error('[runtime] Workflow segment could not be persisted', {
                runId: run.id,
                position: run.position.kind,
                fault: fault._tag,
              });
              return halted(`fault:${fault._tag}`);
            }),
          ),
        );
        if (outcome.kind === 'advanced') moved += 1;
      }
      total += moved;
      if (moved === 0) {
        exhausted = false;
        break;
      }
    }
    return { advanced: total, passes, exhausted } satisfies DrainSummary;
  });

  return { drainOnce, advanceRun };
}

/**
 * One segment for one run.
 *
 * The node kind is resolved from the pin *before* anything is claimed, because a subgraph
 * registration is entered structurally: no author callback runs, so no attempt is allocated and
 * there is nothing for an attempt-ownership fence to hold. That transaction carries the claim's own
 * gates instead.
 */
function advance(
  deps: DispatcherDeps,
  run: WorkflowRunRecord,
): Effect.Effect<SegmentOutcome, SegmentFault> {
  return Effect.gen(function* () {
    /**
     * Three positions this worker never touches, and `environment_preparation` is the deliberate one.
     *
     * The dispatcher is a single worker fiber running one segment per claim across every run. A
     * preparation can spend minutes inside `git worktree add`, setup hooks and post-create
     * commands, so claiming one here would stall every other run in the system. Only the launch
     * request and the Retry control drive that segment, each on its own fiber, and there is
     * deliberately no fallback for a preparation left `ready` — startup recovery fails it instead,
     * so Retry stays its single re-entry path.
     */
    if (
      run.position.kind === 'terminal' ||
      run.position.kind === 'awaiting_wait' ||
      run.position.kind === 'environment_preparation'
    ) {
      return halted(`not_dispatchable:${run.position.kind}`);
    }

    const artifact = yield* loadPin(deps, run);
    if (!artifact) return halted('pinned_load_failed');

    if (run.position.kind === 'node_callback') {
      const structural = yield* structuralSubgraphEntry(deps, run, artifact);
      if (structural) return structural;
      // Settle recorded operations before a callback can be re-entered. A first entry has none, so
      // this is a single indexed read; a re-entry meets settled receipts rather than uncertainty.
      const reconciled = yield* deps.reconcileExecution(run.position.executionId);
      if (reconciled.uncertainOperationId !== null) {
        return halted('blocked_on_uncertain_operation');
      }
    }

    const prepared = yield* prepareClaim(deps, run);
    if (!prepared) return halted('claim_preparation_failed');

    const claimed = yield* deps.runs.claimSegment({
      runId: run.id,
      controlRevision: run.controlRevision,
      owner: deps.owner,
      ownerIncarnation: deps.ownerIncarnation,
      input: { value: prepared.input },
      preparation: prepared.preparation,
    });
    if (!claimed.ok) return halted(`claim_rejected:${claimed.rejection.kind}`);

    const ctx: SegmentContext = {
      run: claimed.value.run,
      attempt: claimed.value.attempt,
      artifact,
    };
    return yield* runSegment(deps, ctx);
  });
}

function runSegment(
  deps: DispatcherDeps,
  ctx: SegmentContext,
): Effect.Effect<SegmentOutcome, SegmentFault> {
  switch (ctx.run.position.kind) {
    case 'graph_entry':
      return runGraphEntry(deps, ctx);
    case 'node_callback':
      return runNodeCallback(deps, ctx);
    case 'routing':
      return runRouting(deps, ctx);
    case 'graph_output':
      return runGraphOutput(deps, ctx);
    case 'child_output_mapping':
      return runOutputMapping(deps, ctx);
    default:
      return Effect.succeed(halted(`not_dispatchable:${ctx.run.position.kind}`));
  }
}

/**
 * Opening a child frame, when the node the run is parked on registers a subgraph.
 *
 * Returns `null` when the node is not a subgraph, so the caller proceeds to claim normally.
 */
function structuralSubgraphEntry(
  deps: DispatcherDeps,
  run: WorkflowRunRecord,
  artifact: LoadedWorkflowArtifact,
): Effect.Effect<SegmentOutcome | null, SegmentFault> {
  return Effect.gen(function* () {
    if (run.position.kind !== 'node_callback') return null;
    const execution = yield* deps.runs.findExecution(run.position.executionId);
    if (!execution) return null;
    const frame = yield* deps.runs.findFrame(execution.frameId);
    const graph = frame ? artifact.graphs.get(frame.graphKey) : undefined;
    const node = graph ? nodeOf(graph, execution.nodeId) : null;
    if (!node || node.isagiKind !== 'subgraph-node') return null;

    const entered = yield* deps.runs.enterSubgraph({
      runId: run.id,
      controlRevision: run.controlRevision,
      expectedPosition: run.position,
      artifactHash: run.artifactHash,
      parentExecutionId: execution.id,
      childGraphKey: node.graph.key,
      // No display name here. A frame's name comes from the child graph's own `label`, evaluated
      // once at the child's entry commit where its parameters exist; this transaction has neither.
    });
    return entered.ok ? advanced : halted(`enter_subgraph_rejected:${entered.rejection.kind}`);
  });
}

/**
 * Loads the run's pinned code.
 *
 * A pin that cannot be loaded is not a segment failure — there is no attempt and no author code to
 * blame — so the run is parked with a diagnostic instead of being retried forever. Retry is the
 * control that resolves it, because it is the one that loads the latest verified version.
 */
function loadPin(
  deps: DispatcherDeps,
  run: WorkflowRunRecord,
): Effect.Effect<LoadedWorkflowArtifact | null, SegmentFault> {
  return deps.catalog
    .loadPinned({ artifactHash: run.artifactHash, workflowKey: run.workflowKey })
    .pipe(
      Effect.catchTag('WorkflowLoadError', (error) =>
        deps.runs
          .appendDiagnostic({
            runId: run.id,
            kind: 'log',
            detail: {
              value: {
                source: 'runtime_diagnostic',
                code: 'pinned_load_failed',
                level: 'error',
                message: `The pinned workflow version could not be loaded (${error.reason}): ${error.message}`,
              },
            },
          })
          .pipe(
            Effect.zipRight(
              deps.runs.applyPause({ runId: run.id, controlRevision: run.controlRevision }),
            ),
            Effect.as(null),
          ),
      ),
    );
}

/**
 * The operands this segment is about to run against, composed the way the repository will check them.
 *
 * Only genuinely mutable sources are fenced. A delivered wait's event and a completed child's output
 * are immutable once written, so recording them as preparation would add ceremony without adding a
 * guarantee; the committed state boundaries the segment reads are what can move under it.
 */
function prepareClaim(
  deps: DispatcherDeps,
  run: WorkflowRunRecord,
): Effect.Effect<
  { readonly input: Record<string, unknown>; readonly preparation: ClaimPreparation } | null,
  SegmentFault
> {
  return Effect.gen(function* () {
    const position = run.position;
    const base = { artifactHash: run.artifactHash };
    const sources: { readonly frameId: number; readonly state: PayloadSlot | null }[] = [];

    /**
     * Omits keys whose operand could not be read.
     *
     * The recorded attempt input has to be serializable — `undefined` inside an object is exactly
     * what the payload boundary refuses — and "absent" is also the honest record: the claim could
     * not read that operand, and the segment about to run will say so with `payload_unavailable`,
     * where there is an attempt to attach the diagnostic to.
     */
    const defined = (input: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

    const stateOf = (frameId: number) =>
      Effect.gen(function* () {
        const frame = yield* deps.runs.findFrame(frameId);
        if (!frame) return { frame: null, value: undefined };
        sources.push({ frameId: frame.id, state: frame.state });
        const value = yield* resolveSlot(deps, frame.state, `State of frame ${frame.id}`).pipe(
          // A payload the claim cannot read is still recorded as the attempt's input, as absent
          // rather than as empty: the segment itself fails with `payload_unavailable`, where there
          // is an attempt to attach the diagnostic to.
          Effect.orElseSucceed(() => undefined),
        );
        return { frame, value };
      });

    switch (position.kind) {
      case 'graph_entry': {
        const entering = yield* stateOf(position.frameId);
        if (!entering.frame) return null;
        const parentExecutionId = entering.frame.parentExecutionId;
        if (parentExecutionId === null) {
          const parameters = yield* resolveSlot(
            deps,
            entering.frame.parameters,
            'Launch parameters',
          ).pipe(Effect.orElseSucceed(() => undefined));
          return {
            input: defined({
              ...base,
              segment: 'graph_entry',
              graphKey: entering.frame.graphKey,
              parameters,
            }),
            preparation: { position, artifactHash: run.artifactHash, frameStates: sources },
          };
        }
        const parentExecution = yield* deps.runs.findExecution(parentExecutionId);
        const parent = parentExecution ? yield* stateOf(parentExecution.frameId) : null;
        return {
          input: defined({
            ...base,
            segment: 'graph_entry',
            graphKey: entering.frame.graphKey,
            parentNodeId: parentExecution?.nodeId ?? null,
            parentState: parent?.value,
          }),
          preparation: { position, artifactHash: run.artifactHash, frameStates: sources },
        };
      }
      case 'node_callback': {
        const owning = yield* stateOf(position.frameId);
        const execution = yield* deps.runs.findExecution(position.executionId);
        if (!owning.frame || !execution) return null;
        const agentTurnRecovery = yield* recoveryInputOf(deps, run);
        return {
          input: defined({
            ...base,
            segment: 'node_callback',
            nodeId: execution.nodeId,
            visitIndex: execution.visitIndex,
            state: owning.value,
            agentTurnRecovery,
          }),
          preparation: { position, artifactHash: run.artifactHash, frameStates: sources },
        };
      }
      case 'routing': {
        const owning = yield* stateOf(position.frameId);
        const execution = yield* deps.runs.findExecution(position.executionId);
        if (!owning.frame || !execution) return null;
        const agentTurnRecovery = yield* recoveryInputOf(deps, run);
        return {
          input: defined({
            ...base,
            segment: 'routing',
            nodeId: execution.nodeId,
            edgeId: position.edgeId,
            state: owning.value,
            agentTurnRecovery,
          }),
          preparation: { position, artifactHash: run.artifactHash, frameStates: sources },
        };
      }
      case 'graph_output': {
        const owning = yield* stateOf(position.frameId);
        if (!owning.frame) return null;
        return {
          input: defined({
            ...base,
            segment: 'graph_output',
            graphKey: owning.frame.graphKey,
            outcomeId: position.outcomeId,
            state: owning.value,
          }),
          preparation: { position, artifactHash: run.artifactHash, frameStates: sources },
        };
      }
      case 'child_output_mapping': {
        const parent = yield* stateOf(position.frameId);
        const execution = yield* deps.runs.findExecution(position.executionId);
        if (!parent.frame || !execution) return null;
        return {
          input: defined({
            ...base,
            segment: 'output_mapping',
            nodeId: execution.nodeId,
            childFrameId: position.childFrameId,
            state: parent.value,
          }),
          preparation: { position, artifactHash: run.artifactHash, frameStates: sources },
        };
      }
      default:
        return null;
    }
  });
}

/** Recovery waits are retained history; only the one resuming this exact saved position is input. */
function recoveryInputOf(
  deps: DispatcherDeps,
  run: WorkflowRunRecord,
): Effect.Effect<AttemptTurnRecovery | undefined, SegmentFault> {
  return Effect.gen(function* () {
    if (run.position.kind !== 'node_callback' && run.position.kind !== 'routing') return undefined;
    const waits = yield* deps.runs.listWaitsForExecution(run.position.executionId);
    for (const wait of [...waits].reverse()) {
      if (wait.status !== 'delivered' || !wait.condition || !wait.event) continue;
      const declarationValue = yield* deps.payloads
        .resolve(wait.condition)
        .pipe(Effect.orElseSucceed(() => null));
      const declaration = recoveryWaitDeclaration(declarationValue);
      if (
        !declaration ||
        encodeRunPosition(declaration.isagiRecovery.resumePosition) !==
          encodeRunPosition(run.position)
      ) {
        continue;
      }
      const event = yield* deps.payloads.resolve(wait.event).pipe(Effect.orElseSucceed(() => null));
      if (!isAgentTurnEvent(event)) return undefined;
      return {
        waitId: wait.id,
        agentSessionId: declaration.target.agentSessionId,
        turn: declaration.isagiRecovery.turn,
        event,
      };
    }
    return undefined;
  });
}
