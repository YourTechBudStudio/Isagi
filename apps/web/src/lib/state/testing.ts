/**
 * Test support for app state: an isolated registry per test with a fake `RuntimeApi`, and helpers
 * to let the registry's scheduled work and Effect fibers run. Test-only; never import it from
 * production code.
 *
 * Rules: one registry per test, always disposed (`t.after(() => registry.dispose())`; retained
 * queries hold idle timers that would keep the test process alive); simulate time with
 * `mock.timers.enable({ apis: ['setTimeout', 'Date'] })`, which drives Effect's default clock and
 * the registry's timers (Effect's `TestClock` does not reach the registry); call `flush()` before
 * moving the clock so scheduled node removals run first (`advance` does both).
 */
import { mock } from 'node:test';

import { Effect, Layer } from 'effect';
import { type Atom, AtomRegistry } from 'effect/reactivity';

import { RuntimeApi, type RuntimeApiShape } from '../runtime/client.js';
import { queryRetryAtom } from './policy.js';
import { runtimeApiLayerAtom } from './runtime.js';

/** Every `RuntimeApiShape` member; the compiler keeps this list complete. */
const runtimeApiMembers = {
  fetchClientSettings: true,
  fetchWorkspace: true,
  fetchDurableSessions: true,
  fetchWorktreeCommands: true,
  fetchCommandLogMetadata: true,
  resolveCommandLogStreamWebSocketUrl: true,
  runCommand: true,
  stopCommand: true,
  restartCommand: true,
  fetchActiveContext: true,
  updateActiveContext: true,
  reconcileWorkspace: true,
  getSurfaceDetail: true,
  renameSurfaceTitle: true,
  deleteSurface: true,
  deleteSurfacePane: true,
  setWorktreeEnvironmentFocus: true,
  createSurface: true,
  splitPane: true,
  startPane: true,
  setSplitWeights: true,
  createPaneSession: true,
  claimPaneSession: true,
  resolveAgentSessionPtyWebSocketUrl: true,
  resolveTerminalSessionPtyWebSocketUrl: true,
  resolveRuntimeEventsWebSocketUrl: true,
  addProject: true,
  relocateProject: true,
  deleteProject: true,
  moveProjectOrder: true,
  moveWorktreeOrder: true,
  moveSurfaceOrder: true,
  listProjectBranches: true,
  preflightWorktreeSetup: true,
  trustWorktreeSetup: true,
  openWorktree: true,
  preflightDeleteWorktree: true,
  deleteWorktree: true,
  suggestProjectPaths: true,
  pauseWorkflow: true,
  resumeWorkflow: true,
  retryWorkflow: true,
  cancelWorkflow: true,
  dismissWorkflow: true,
  advanceWorkflow: true,
  getWorkflowRun: true,
  listWorkflowRuns: true,
  getWorkflowStructure: true,
  listWorkflowEvents: true,
  getWorkflowExecution: true,
  listWorkflowCheckpoints: true,
  getWorkflowCheckpoint: true,
  fetchWorkflowCheckpointFile: true,
  workflowCheckpointFileUrl: true,
  listWorkflowDescriptors: true,
  startWorkflow: true,
  getControlPlane: true,
  refreshInventory: true,
  acceptHarnessPolicy: true,
  openEditor: true,
  ensureEditorRuntime: true,
  editorDiagnostics: true,
  retryEditorProvisioning: true,
  runtimeIdentity: true,
} satisfies Record<keyof RuntimeApiShape, true>;

/**
 * A fake `RuntimeApi`: the given members, and every other member dies with "`<name>` is not used"
 * (the runtime test convention), so a test states exactly which endpoints it expects.
 *
 * Fakes must be lazy: record a call inside `Effect.sync` / `Effect.suspend`, not in the method body,
 * because `Effect.andThen(api.x(input))` evaluates `api.x(input)` before the effect runs.
 */
export const makeFakeRuntimeApi = (overrides: Partial<RuntimeApiShape> = {}): RuntimeApiShape => {
  const unused = Object.fromEntries(
    Object.keys(runtimeApiMembers).map((name) => [
      name,
      () => Effect.die(new Error(`RuntimeApi.${name} is not used`)),
    ]),
  );
  return RuntimeApi.of({ ...unused, ...overrides } as RuntimeApiShape);
};

export interface TestRegistryOptions {
  /** The fake runtime API; unspecified members die. */
  readonly api?: Partial<RuntimeApiShape> | undefined;
  /** `false` turns query retries off for the whole registry (fail on the first error). */
  readonly retry?: boolean | undefined;
  readonly initialValues?: Iterable<readonly [Atom.Atom<any>, any]> | undefined;
}

/** An isolated app session for one test. Dispose it in `t.after`. */
export const makeTestRegistry = (options: TestRegistryOptions = {}): AtomRegistry.AtomRegistry =>
  AtomRegistry.make({
    initialValues: [
      [runtimeApiLayerAtom, Layer.succeed(RuntimeApi, makeFakeRuntimeApi(options.api))],
      ...(options.retry === false ? [[queryRetryAtom, null] as const] : []),
      ...(options.initialValues ?? []),
    ],
  });

/** Let fibers, registry tasks (scheduled on `setImmediate`) and microtasks run. */
export const flush = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** Move mocked time with the event loop running: settle scheduled work, tick, settle again. */
export const advance = async (ms: number): Promise<void> => {
  await flush();
  mock.timers.tick(ms);
  await flush();
};

/** One request whose answer the test decides; `aborted` records client-side interruption. */
export interface PendingCall<A, E> {
  readonly resolve: (value: A) => void;
  readonly reject: (error: E) => void;
  aborted: boolean;
  settled: boolean;
}

/** A fake endpoint whose every call stays pending until the test answers it. */
export const controllable = <A, E = never>() => {
  const calls: Array<PendingCall<A, E>> = [];
  const effect = Effect.callback<A, E>((resume) => {
    const call: PendingCall<A, E> = {
      aborted: false,
      settled: false,
      resolve: (value) => {
        call.settled = true;
        resume(Effect.succeed(value));
      },
      reject: (error) => {
        call.settled = true;
        resume(Effect.fail(error));
      },
    };
    calls.push(call);
    return Effect.sync(() => {
      call.aborted = true;
    });
  });
  const last = (): PendingCall<A, E> => {
    const call = calls.at(-1);
    if (call === undefined) throw new Error('no call has been made');
    return call;
  };
  return { calls, effect, last };
};
