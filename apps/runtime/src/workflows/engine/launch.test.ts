import assert from 'node:assert/strict';
import test from 'node:test';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  subgraph,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { eq } from 'drizzle-orm';

import { projects, workflowGraphInvocations, workflowRuns } from '../../persistence/schema.js';
import { WorkflowEngineError } from '../errors.js';
import { deleteRunsOfProject } from '../store/runs.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { withEngine, type EngineHarness } from './test-support.js';

/**
 * Launch `parse`: it refuses a launch or turns it into the root graph's parameters, once per run.
 * The parameters are stored on the run and are what placement, preparation's Retry and the root
 * graph's `init` see.
 */

const runRows = (harness: EngineHarness) => harness.db.select().from(workflowRuns).all();
const rootInvocation = (harness: EngineHarness, runId: number) =>
  harness.db
    .select()
    .from(workflowGraphInvocations)
    .where(eq(workflowGraphInvocations.runId, runId))
    .all()
    .find((invocation) => invocation.parentExecutionId === null)!;

/** A one-node root graph that records the parameters its `init` received. */
function recordingGraph<Parameters>(seen: unknown[]) {
  return createGraph<{ readonly n: number }, {}, Parameters, null>({
    key: 'root',
    title: 'Root',
    init: (_destination, parameters) => {
      seen.push(parameters);
      return { n: 0 };
    },
    state: { n: reduce.replace<number>() },
    entry: 'work',
    nodes: { work: operation<{ readonly n: number }, {}>(async () => complete()) },
    edges: { out: edge({ from: 'work', to: ['done'], choose: () => ({ to: 'done' }) }) },
    outcomes: { done: outcome({ kind: 'success', output: () => null }) },
  });
}

const publish = (harness: EngineHarness, key: string, definition: unknown) =>
  harness.registry.publish(key, definition as AnyWorkflowDefinition);

test('a parse that throws refuses the launch with its message, verbatim, and creates no run', async () => {
  await withEngine(async (harness) => {
    let placementCalls = 0;
    publish(
      harness,
      'refusing',
      defineWorkflow({
        command: () => ({ title: 'Refusing' }),
        parse: (): { readonly n: number } => {
          throw new Error('Launch this from an agent pane.');
        },
        placement: () => {
          placementCalls += 1;
          return { worktree: { kind: 'current' }, surface: { kind: 'current' } };
        },
        graph: recordingGraph<{ readonly n: number }>([]),
      }),
    );
    const refused = await harness.fail(
      harness.engine.launch({
        workflowKey: 'refusing',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: 1 },
      }),
    );
    assert.ok(refused instanceof WorkflowEngineError);
    assert.equal(refused.code, 'workflow_parse_rejected');
    assert.equal(refused.message, 'Launch this from an agent pane.');
    assert.equal(refused.workflowKey, 'refusing');
    assert.equal(placementCalls, 0, 'a refused launch never reaches placement');
    assert.deepEqual(runRows(harness), []);
  });
});

test('a parse that returns what cannot be stored is an author defect, and creates no run', async () => {
  await withEngine(async (harness) => {
    publish(
      harness,
      'unstorable',
      defineWorkflow({
        command: () => ({ title: 'Unstorable' }),
        parse: () => ({ seen: new Map<string, number>() }),
        graph: recordingGraph<{ readonly seen: Map<string, number> }>([]),
      }),
    );
    const refused = await harness.fail(
      harness.engine.launch({
        workflowKey: 'unstorable',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: 1 },
      }),
    );
    assert.ok(refused instanceof WorkflowEngineError);
    assert.equal(refused.code, 'workflow_parameters_invalid');
    assert.match(refused.message, /parameters\.seen/);
    assert.deepEqual(runRows(harness), []);
  });
});

test('an async parse runs once; placement, the root graph and run detail see what it returned', async () => {
  await withEngine(async (harness) => {
    const parsed: unknown[] = [];
    const returned: unknown[] = [];
    const placed: unknown[] = [];
    const initialized: unknown[] = [];
    interface Parameters {
      readonly branch: string;
      readonly topic: string;
    }
    publish(
      harness,
      'isolated',
      defineWorkflow({
        command: () => ({ title: 'Isolated' }),
        parse: async (_origin, inputs): Promise<Parameters> => {
          await Promise.resolve();
          parsed.push(inputs);
          const parameters = {
            branch: `topic-${String(inputs.topic)}`,
            topic: String(inputs.topic),
          };
          returned.push(parameters);
          return parameters;
        },
        placement: (_ctx, parameters) => {
          placed.push(parameters);
          return {
            worktree: { kind: 'create', branch: parameters.branch, fromRef: 'main' },
            surface: { kind: 'create', title: parameters.topic },
          };
        },
        graph: recordingGraph<Parameters>(initialized),
      }),
    );
    // The first preparation fails, so its Retry is a second trip through preparation.
    harness.places.setupResults = ['failed'];
    const runId = await harness.launch('isolated', { inputs: { topic: 'docs' } });
    assert.equal((await harness.run(harness.engine.getRun(runId))).run.status, 'failed');
    await harness.run(harness.engine.retry(runId));

    const expected = { branch: 'topic-docs', topic: 'docs' };
    const detail = await harness.run(harness.engine.getRun(runId));
    assert.equal(detail.run.status, 'completed', JSON.stringify(detail.run.error));
    assert.deepEqual(parsed, [{ topic: 'docs' }], 'parse ran exactly once, at launch');
    assert.deepEqual(placed, [expected]);
    assert.deepEqual(initialized, [expected]);
    // Placement gets the stored value read back, not the object `parse` returned.
    assert.notEqual(placed[0], returned[0]);
    assert.deepEqual(detail.inputs, { topic: 'docs' });
    assert.deepEqual(detail.parameters, expected);
    assert.deepEqual(rootInvocation(harness, runId).parametersJson, JSON.stringify(expected));
    assert.ok(harness.places.calls.includes(`openWorktree topic-docs ${'a'.repeat(40)}`));
  });
});

test('a parse that returns nothing stores null; placement and the root graph both get undefined', async () => {
  await withEngine(async (harness) => {
    const placed: unknown[] = [];
    const initialized: unknown[] = [];
    publish(
      harness,
      'nothing',
      defineWorkflow({
        command: () => ({ title: 'Nothing' }),
        parse: () => undefined,
        placement: (_ctx, parameters) => {
          placed.push(parameters);
          return { worktree: { kind: 'current' }, surface: { kind: 'current' } };
        },
        graph: recordingGraph<undefined>(initialized),
      }),
    );
    const runId = await harness.launch('nothing', { inputs: { ignored: true } });
    const detail = await harness.run(harness.engine.getRun(runId));
    assert.equal(detail.run.status, 'completed', JSON.stringify(detail.run.error));
    assert.equal(detail.parameters, null);
    assert.deepEqual(placed, [undefined]);
    assert.deepEqual(initialized, [undefined]);
  });
});

interface DriveParameters {
  readonly agentSessionId: number;
}

/** One graph that prompts the agent session it is handed, however it was entered. */
const DriveAgentGraph = createGraph<DriveParameters, {}, DriveParameters, number>({
  key: 'drive-agent',
  title: 'Drive an agent',
  init: (_destination, parameters) => ({ agentSessionId: parameters.agentSessionId }),
  state: { agentSessionId: reduce.replace<number>() },
  entry: 'prompt',
  nodes: {
    prompt: operation<DriveParameters, {}>(async (ctx, state) => {
      await ctx.sendAgentPrompt({ agentSessionId: state.agentSessionId, prompt: 'Carry on.' });
      return complete();
    }),
  },
  edges: { out: edge({ from: 'prompt', to: ['done'], choose: () => ({ to: 'done' }) }) },
  outcomes: { done: outcome({ kind: 'success', output: (state) => state.agentSessionId }) },
});

const requireLaunchingAgent = (origin: { readonly agentSessionId?: number | null | undefined }) => {
  if (origin.agentSessionId === undefined || origin.agentSessionId === null) {
    throw new Error('Launch this from the agent pane it should drive.');
  }
  return origin.agentSessionId;
};

test('the launching agent reaches one graph through parse as a root and through parameters as a subgraph', async () => {
  await withEngine(async (harness) => {
    const agentSessionId = harness.agents.addSession();
    const paneId = harness.places.addAgentPane(1, agentSessionId);

    publish(
      harness,
      'as-root',
      defineWorkflow({
        command: () => ({ title: 'As root' }),
        parse: (origin): DriveParameters => ({ agentSessionId: requireLaunchingAgent(origin) }),
        graph: DriveAgentGraph,
      }),
    );
    interface ParentState {
      readonly agent: number;
    }
    publish(
      harness,
      'as-subgraph',
      defineWorkflow({
        command: () => ({ title: 'As subgraph' }),
        parse: (origin): ParentState => ({ agent: requireLaunchingAgent(origin) }),
        graph: createGraph<ParentState, {}, ParentState, null>({
          key: 'parent',
          title: 'Parent',
          init: (_destination, parameters) => ({ agent: parameters.agent }),
          state: { agent: reduce.replace<number>() },
          entry: 'drive',
          nodes: {
            drive: subgraph({
              graph: DriveAgentGraph,
              title: 'Drive the agent',
              parameters: (parent: ParentState): DriveParameters => ({
                agentSessionId: parent.agent,
              }),
              onResult: () => ({}),
            }),
          },
          edges: { out: edge({ from: 'drive', to: ['done'], choose: () => ({ to: 'done' }) }) },
          outcomes: { done: outcome({ kind: 'success', output: () => null }) },
        }),
      }),
    );

    const launchFromAgent = (workflowKey: string) =>
      harness.run(
        harness.engine.launch({
          workflowKey,
          inputs: {},
          origin: { worktreeId: 1, surfaceId: 1, paneId, agentSessionId },
        }),
      );

    const asRoot = (await launchFromAgent('as-root')).runId;
    const rootDetail = await harness.run(harness.engine.getRun(asRoot));
    assert.equal(rootDetail.run.status, 'completed', JSON.stringify(rootDetail.run.error));
    assert.equal(rootDetail.run.outcome?.output, agentSessionId);
    assert.deepEqual(rootDetail.parameters, { agentSessionId });
    // A surface holds one attached run; release it for the second launch.
    await harness.run(harness.engine.dismiss(asRoot));

    const asSubgraph = (await launchFromAgent('as-subgraph')).runId;
    const subgraphDetail = await harness.run(harness.engine.getRun(asSubgraph));
    assert.equal(subgraphDetail.run.status, 'completed', JSON.stringify(subgraphDetail.run.error));
    const child = subgraphDetail.invocations.find(
      (invocation) => invocation.graphKey === 'drive-agent',
    );
    assert.deepEqual(child?.parameters, { agentSessionId });

    assert.deepEqual(
      harness.agents.prompts.map((prompt) => [prompt.kind, prompt.agentSessionId]),
      [
        ['send', agentSessionId],
        ['send', agentSessionId],
      ],
      'both entrances drove the agent the workflow was launched from',
    );

    // Launched from a pane with no agent, the same workflow refuses with its own message.
    const refused = await harness.fail(
      harness.engine.launch({
        workflowKey: 'as-root',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: 1 },
      }),
    );
    assert.ok(refused instanceof WorkflowEngineError);
    assert.equal(refused.code, 'workflow_parse_rejected');
    assert.equal(refused.message, 'Launch this from the agent pane it should drive.');
  });
});

/**
 * Launch admission: a run exists only while its project does. Project deletion erases runs in its
 * own transaction, and `workflow_launch` refuses a project that is gone, so whichever commits first,
 * a deleted project ends with no runs.
 */

test('a launch whose project is deleted before the run is committed is refused and creates no run', async () => {
  await withEngine(async (harness) => {
    publish(
      harness,
      'orphaned',
      defineWorkflow({
        command: () => ({ title: 'Orphaned' }),
        // `parse` runs after the project was resolved and before the run is committed.
        parse: () => {
          harness.db.delete(projects).where(eq(projects.id, 1)).run();
          return { n: 1 };
        },
        graph: recordingGraph<{ readonly n: number }>([]),
      }),
    );
    const refused = await harness.fail(
      harness.engine.launch({
        workflowKey: 'orphaned',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: 1 },
      }),
    );
    assert.ok(refused instanceof WorkflowEngineError);
    assert.equal(refused.code, 'worktree_not_found');
    assert.equal(refused.message, 'Project 1 no longer exists.');
    assert.equal(refused.workflowKey, 'orphaned');
    assert.deepEqual(runRows(harness), []);
    assert.deepEqual(
      harness.events.filter((event) => event.type === 'workflow_run_event'),
      [],
      'a refused launch emits nothing',
    );
  });
});

test('a run committed before its project is deleted is erased by the delete', async () => {
  await withEngine(async (harness) => {
    publish(
      harness,
      'committed',
      defineWorkflow({
        command: () => ({ title: 'Committed' }),
        parse: () => ({ n: 1 }),
        graph: recordingGraph<{ readonly n: number }>([]),
      }),
    );
    const runId = await harness.launch('committed');
    assert.deepEqual(
      runRows(harness).map((run) => run.id),
      [runId],
    );
    // The shape of the workspace's `delete_project` transaction.
    harness.db.transaction((db) => {
      deleteRunsOfProject(db, 1);
      db.delete(projects).where(eq(projects.id, 1)).run();
    });
    await harness.settle();
    assert.deepEqual(runRows(harness), []);
  });
});
