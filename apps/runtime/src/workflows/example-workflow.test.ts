import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import type { WorkflowContext, WorkflowLaunchContext } from '@isagi/workflow-sdk';

import { configureIsagiExampleWorkflowSource } from '../runtime-assets.js';
import { loadWorkflowDefinition } from './loader.js';
import { ensureWorkflowsScaffold } from './scaffold.js';

/**
 * The workflow embedded in the configure-isagi skill is the file every user workflow gets cloned
 * from. These tests drive it through the same loader a real run uses, then exercise the reducer so
 * the shipped example cannot silently stop working.
 */

const worktreePath = '/tmp/isagi-example-worktree';

const launchCtx: WorkflowLaunchContext = {
  worktreeId: 1,
  worktreePath,
  surfaceId: 2,
  paneId: 3,
  agentSessionId: 5,
};

test('the skill example workflow compiles, imports, and shape-checks through the real loader', async () => {
  await withLoadedExample(async (definition) => {
    const manifest = await definition.command(launchCtx);
    assert.equal(manifest.title, 'Second opinion');
    assert.equal(manifest.inputs?.[0]?.key, 'question');
  });
});

test('the skill example workflow builds its manifest without a pane or agent session', async () => {
  await withLoadedExample(async (definition) => {
    // Verification calls command() with exactly this synthetic launch context.
    const manifest = await definition.command({ worktreeId: 0, worktreePath, surfaceId: 0 });
    assert.equal(manifest.title, 'Second opinion');
  });
});

test('the skill example workflow rejects launches it cannot drive', async () => {
  await withLoadedExample(async (definition) => {
    assert.throws(
      () => definition.validate({ ...launchCtx, agentSessionId: null }, { question: 'anything' }),
      /agent pane/,
    );
    assert.throws(() => definition.validate(launchCtx, { question: '   ' }), /question/);
  });
});

test('the skill example workflow suspends on the turn it just started', async () => {
  await withLoadedExample(async (definition) => {
    const spawned = {
      agentSessionId: 7,
      sentAt: '2026-01-01T00:00:00.000Z',
      paneId: 9,
    };
    const phases: (string | undefined)[] = [];
    const ctx = stubContext({
      spawnAgentSession: async () => spawned,
      setUiFeedback: async (feedback) => {
        phases.push(feedback.phase);
      },
    });

    const state = await definition.init(launchCtx, {
      question: 'Does this migration lose data?',
    });
    const result = await definition.step(ctx, state, undefined);

    assert.ok(result.type === 'suspend');
    assert.deepEqual(result.condition, {
      kind: 'agent_turn',
      agentSessionId: spawned.agentSessionId,
      sentAt: spawned.sentAt,
    });
    assert.deepEqual(phases, ['Asking a reviewer']);
    assert.deepEqual(JSON.parse(JSON.stringify(result.state)), result.state);
  });
});

async function withLoadedExample(
  run: (definition: Awaited<ReturnType<typeof loadExample>>) => Promise<void>,
) {
  const dataRoot = join(tmpdir(), `isagi-example-workflow-${process.pid}-${Date.now()}`);
  try {
    await run(await loadExample(dataRoot));
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

async function loadExample(dataRoot: string) {
  const workflowsPath = join(dataRoot, 'workflows');
  const workflowPath = join(workflowsPath, 'second-opinion');
  await Effect.runPromise(ensureWorkflowsScaffold({ workflowsPath }));
  mkdirSync(workflowPath, { recursive: true });
  writeFileSync(join(workflowPath, 'index.ts'), configureIsagiExampleWorkflowSource, 'utf8');

  return Effect.runPromise(
    loadWorkflowDefinition({
      workflowKey: 'second-opinion',
      indexPath: join(workflowPath, 'index.ts'),
      artifactPath: join(
        workflowsPath,
        '.cache',
        'workflow-definitions',
        'second-opinion',
        'example',
        'index.mjs',
      ),
      compileMode: 'external',
    }),
  );
}

/**
 * Typed against the SDK's `WorkflowContext` on purpose: when the verb surface changes, this test
 * should stop compiling. Every verb the example is not supposed to reach throws rather than no-ops.
 */
function stubContext(overrides: {
  readonly spawnAgentSession: WorkflowContext['spawnAgentSession'];
  readonly setUiFeedback: WorkflowContext['setUiFeedback'];
}): WorkflowContext {
  const unexpected = (verb: string) => async (): Promise<never> => {
    throw new Error(`The example workflow called ctx.${verb} during its first step.`);
  };
  return {
    worktreePath,
    spawnAgentSession: overrides.spawnAgentSession,
    sendAgentPrompt: unexpected('sendAgentPrompt'),
    closePane: unexpected('closePane'),
    getConversationHistory: unexpected('getConversationHistory'),
    runHeadlessAgent: unexpected('runHeadlessAgent'),
    startWorkflow: unexpected('startWorkflow'),
    log: async () => {},
    setUiFeedback: overrides.setUiFeedback,
  };
}
