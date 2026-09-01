import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import {
  HarnessAdapterRegistry,
  type HarnessAdapterRegistryService,
} from '../agent-sessions/harness/index.js';
import { HarnessLaunchBlocked } from '../harness-control-plane/index.js';
import {
  AllowAllHarnessControlPlaneLayer,
  blockedHarnessControlPlaneLayer,
} from '../harness-control-plane/test-support.js';
import { PtyService, type PtyServiceShape } from '../pty-processes/index.js';
import type { LaunchPtyProcessInput } from '../pty-processes/types.js';
import { InternalRuntimeEventBus, InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import { WorkflowHeadless, WorkflowHeadlessLive } from './headless.js';
import { WorkflowPromptInputError } from './prompt-renderer.js';

// The live tracker owns PTY lifetime for headless ops. These tests cover the
// resource-ownership edges: an op must not outlive its run, and consumed ops must
// not linger in the in-memory map. Pure output parsing lives in `headless.test.ts`.

type PtyCalls = { readonly terminated: number[]; readonly unpinned: number[] };

const firstPtyProcessId = 100;

function makeFakePty(calls: PtyCalls, onLaunch?: (() => void) | undefined): PtyServiceShape {
  let nextPtyProcessId = firstPtyProcessId;
  return {
    allocateLaunch: () => Effect.die('pty allocateLaunch is not used'),
    readLogTail: () => Effect.die('readLogTail is not used'),
    launch: () =>
      Effect.sync(() => {
        onLaunch?.();
        const ptyProcessId = nextPtyProcessId;
        nextPtyProcessId += 1;
        return { ptyProcessId, command: 'agent', args: [], cwd: '/tmp/wt', logPath: null };
      }),
    pin: () => Effect.void,
    unpin: (input) =>
      Effect.sync(() => {
        calls.unpinned.push(input.ptyProcessId);
      }),
    terminate: (input) =>
      Effect.sync(() => {
        calls.terminated.push(input.ptyProcessId);
        return 'terminated_live' as const;
      }),
    getAttachmentPlan: () => Effect.die('pty getAttachmentPlan is not used'),
    attach: () => Effect.die('pty attach is not used'),
    replay: () => Effect.die('pty replay is not used'),
    write: () => Effect.die('pty write is not used'),
    writeInput: () => Effect.die('pty writeInput is not used'),
    resize: () => Effect.die('pty resize is not used'),
    kill: () => Effect.die('pty kill is not used'),
    cleanupProcess: () => Effect.die('pty cleanupProcess is not used'),
    isPinned: () => Effect.succeed(false),
  };
}

const fakeHarnesses: HarnessAdapterRegistryService = {
  buildLaunch: () => Effect.die('buildLaunch is not used'),
  buildHeadlessLaunch: () =>
    Effect.succeed({ command: 'agent', args: [], cwd: '/tmp/wt' } satisfies LaunchPtyProcessInput),
};

function makeLayer(
  calls: PtyCalls,
  controlPlaneLayer = AllowAllHarnessControlPlaneLayer,
  onLaunch?: (() => void) | undefined,
  harnesses: HarnessAdapterRegistryService = fakeHarnesses,
) {
  // The bus layer is shared by reference, so the tracker's subscription and the
  // test's publisher resolve to the same in-memory event bus instance.
  const bus = InternalRuntimeEventBusLive;
  const headless = WorkflowHeadlessLive.pipe(
    Layer.provide(Layer.succeed(HarnessAdapterRegistry, harnesses)),
    Layer.provide(Layer.succeed(PtyService, makeFakePty(calls, onLaunch))),
    Layer.provide(bus),
    Layer.provide(controlPlaneLayer),
  );
  return Layer.merge(headless, bus);
}

const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      yield* Effect.sleep('5 millis');
    }
  });

const launchPrompt = { harness: 'claude', prompt: 'judge', timeoutMs: 60_000 } as const;

test('headless workflow launch is blocked before a PTY is created', async () => {
  const calls: PtyCalls = { terminated: [], unpinned: [] };
  let launchCalls = 0;
  const layer = makeLayer(calls, blockedHarnessControlPlaneLayer('harness_disabled'), () => {
    launchCalls += 1;
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const headless = yield* WorkflowHeadless;
      return yield* headless
        .runHeadlessAgent({ runId: 7, worktreePath: '/tmp/wt', prompt: launchPrompt })
        .pipe(Effect.either);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  assert.equal(launchCalls, 0);
  assert.equal(
    result._tag === 'Left' && result.left instanceof HarnessLaunchBlocked
      ? result.left.reason
      : null,
    'harness_disabled',
  );
});

test('headless workflow renders before adapter and PTY launch and persists rendered text', async () => {
  const calls: PtyCalls = { terminated: [], unpinned: [] };
  const adapterPrompts: string[] = [];
  const harnesses: HarnessAdapterRegistryService = {
    ...fakeHarnesses,
    buildHeadlessLaunch: (input) =>
      Effect.sync(() => {
        adapterPrompts.push(input.prompt);
        return { command: 'agent', args: [], cwd: input.cwd } satisfies LaunchPtyProcessInput;
      }),
  };
  const op = await Effect.runPromise(
    Effect.gen(function* () {
      const headless = yield* WorkflowHeadless;
      return yield* headless.runHeadlessAgent({
        runId: 7,
        worktreePath: '/tmp/wt',
        prompt: {
          harness: 'codex',
          modifiers: [{ kind: 'skill', name: 'review' }],
          prompt: '  inspect this',
          timeoutMs: 60_000,
        },
      });
    }).pipe(
      Effect.provide(makeLayer(calls, AllowAllHarnessControlPlaneLayer, undefined, harnesses)),
      Effect.scoped,
    ),
  );

  assert.deepEqual(adapterPrompts, ['$review   inspect this']);
  assert.equal(op.launch.prompt, '$review   inspect this');
});

test('invalid headless workflow input fails before adapter and PTY launch', async () => {
  const calls: PtyCalls = { terminated: [], unpinned: [] };
  let adapterCalls = 0;
  let launchCalls = 0;
  const harnesses: HarnessAdapterRegistryService = {
    ...fakeHarnesses,
    buildHeadlessLaunch: () =>
      Effect.sync(() => {
        adapterCalls += 1;
        return { command: 'agent', args: [], cwd: '/tmp/wt' } satisfies LaunchPtyProcessInput;
      }),
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const headless = yield* WorkflowHeadless;
      return yield* headless
        .runHeadlessAgent({
          runId: 7,
          worktreePath: '/tmp/wt',
          prompt: { harness: 'pi', prompt: '   ' },
        })
        .pipe(Effect.either);
    }).pipe(
      Effect.provide(
        makeLayer(
          calls,
          AllowAllHarnessControlPlaneLayer,
          () => {
            launchCalls += 1;
          },
          harnesses,
        ),
      ),
      Effect.scoped,
    ),
  );

  assert.ok(result._tag === 'Left' && result.left instanceof WorkflowPromptInputError);
  assert.equal(adapterCalls, 0);
  assert.equal(launchCalls, 0);
});

test('headless reissue submits the persisted rendered prompt without rendering again', async () => {
  const calls: PtyCalls = { terminated: [], unpinned: [] };
  const adapterPrompts: string[] = [];
  const harnesses: HarnessAdapterRegistryService = {
    ...fakeHarnesses,
    buildHeadlessLaunch: (input) =>
      Effect.sync(() => {
        adapterPrompts.push(input.prompt);
        return { command: 'agent', args: [], cwd: input.cwd } satisfies LaunchPtyProcessInput;
      }),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const headless = yield* WorkflowHeadless;
      yield* headless.reissue({
        runId: 7,
        worktreePath: '/tmp/wt',
        ops: [
          {
            opId: 'headless:persisted',
            launch: { harness: 'codex', prompt: '$review preserved', timeoutMs: 60_000 },
          },
        ],
      });
    }).pipe(
      Effect.provide(makeLayer(calls, AllowAllHarnessControlPlaneLayer, undefined, harnesses)),
      Effect.scoped,
    ),
  );

  assert.deepEqual(adapterPrompts, ['$review preserved']);
});

test('a terminal workflow run cancels its in-flight headless op', async () => {
  const calls: PtyCalls = { terminated: [], unpinned: [] };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const headless = yield* WorkflowHeadless;
      const bus = yield* InternalRuntimeEventBus;
      const op = yield* headless.runHeadlessAgent({
        runId: 7,
        worktreePath: '/tmp/wt',
        prompt: launchPrompt,
      });
      yield* bus.publish({ type: 'workflow_run_terminal', runId: 7, status: 'failed' });
      yield* waitUntil(() => calls.terminated.length > 0);
      const after = yield* headless.completedResults({ kind: 'headless_agent', ops: [op] });
      return { after };
    }).pipe(Effect.provide(makeLayer(calls)), Effect.scoped),
  );

  assert.deepEqual(calls.terminated, [firstPtyProcessId]);
  assert.deepEqual(calls.unpinned, [firstPtyProcessId]);
  assert.equal(result.after, null);
});

test('releaseOps tears down a tracked headless op and frees its PTY', async () => {
  const calls: PtyCalls = { terminated: [], unpinned: [] };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const headless = yield* WorkflowHeadless;
      const op = yield* headless.runHeadlessAgent({
        runId: 7,
        worktreePath: '/tmp/wt',
        prompt: launchPrompt,
      });
      yield* headless.releaseOps({ opIds: [op.opId] });
      const after = yield* headless.completedResults({ kind: 'headless_agent', ops: [op] });
      return { after };
    }).pipe(Effect.provide(makeLayer(calls)), Effect.scoped),
  );

  assert.deepEqual(calls.terminated, [firstPtyProcessId]);
  assert.equal(result.after, null);
});
