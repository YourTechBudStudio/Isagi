/**
 * `workflows list` and `runs launch`: origin resolution from the current directory, explicit origin
 * flags, placement and inputs.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { RuntimeApiError } from '@isagi/runtime-client';

import { fail, fakeRuntime, onlyJsonDocument, runIsagi } from '../testing/cli-harness.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project at `<root>/repo` with a linked worktree nested inside it at `<root>/repo/.wt/feature`. */
function workspace(options: { readonly featureSurface?: number | null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-cli-origin-')));
  roots.push(root);
  const repo = join(root, 'repo');
  const feature = join(repo, '.wt', 'feature');
  mkdirSync(join(feature, 'src'), { recursive: true });
  const runtime = fakeRuntime({
    'workspace.get': () => ({
      projects: [
        {
          id: 1,
          rootPath: repo,
          worktrees: [
            { id: 10, path: repo, activeSurfaceId: 100 },
            {
              id: 11,
              path: feature,
              activeSurfaceId: options.featureSurface === undefined ? 111 : options.featureSurface,
            },
          ],
        },
      ],
    }),
    'workflows.descriptors': () => ({ workflows: [{ workflowKey: 'implement-story' }] }),
    'workflows.start': (body) => ({
      runId: 77,
      workflowKey: (body as { workflowKey: string }).workflowKey,
    }),
  });
  return { root, repo, feature, runtime };
}

test('the origin is the longest worktree prefix of the cwd, with that worktree’s focused surface', async () => {
  const setup = workspace();
  const run = await runIsagi(['workflows', 'list', '--json'], {
    runtime: setup.runtime,
    cwd: join(setup.feature, 'src'),
  });
  assert.equal(run.code, 0, run.stdout);
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    origin: { worktreeId: 11, surfaceId: 111 },
    workflows: [{ workflowKey: 'implement-story' }],
  });
  assert.deepEqual(setup.runtime.calls[1]!.args, [{ origin: { worktreeId: 11, surfaceId: 111 } }]);

  // A sibling whose name only starts with the worktree's name is not inside it.
  mkdirSync(join(setup.root, 'repo-other'));
  const outside = await runIsagi(['workflows', 'list', '--json'], {
    runtime: setup.runtime,
    cwd: join(setup.root, 'repo-other'),
  });
  assert.equal(outside.code, 1);
  assert.deepEqual(onlyJsonDocument(outside.stdout), {
    error: {
      code: 'origin_unresolved',
      message: `${join(setup.root, 'repo-other')} is not inside any worktree Isagi knows; pass --worktree.`,
      data: { cwd: join(setup.root, 'repo-other') },
    },
  });
});

test('a worktree without a focused surface is an origin with no surface', async () => {
  const setup = workspace({ featureSurface: null });
  const run = await runIsagi(['runs', 'launch', 'implement-story', '--json'], {
    runtime: setup.runtime,
    cwd: setup.feature,
  });
  assert.equal(run.code, 0, run.stdout);
  const document = onlyJsonDocument(run.stdout) as { origin: unknown };
  assert.deepEqual(document.origin, { worktreeId: 11, surfaceId: null });
  assert.ok(setup.runtime.calls.some((call) => call.endpointId === 'workflows.start'));
});

test('--worktree alone is an origin with no surface', async () => {
  const setup = workspace();
  const run = await runIsagi(['workflows', 'list', '--worktree', '10', '--json'], {
    runtime: setup.runtime,
    cwd: setup.feature,
  });
  assert.equal(run.code, 0, run.stdout);
  assert.deepEqual(setup.runtime.calls[0]!.args, [{ origin: { worktreeId: 10, surfaceId: null } }]);
});

test('explicit --worktree and --surface win over the cwd and skip the snapshot', async () => {
  const setup = workspace();
  const run = await runIsagi(
    ['runs', 'launch', 'implement-story', '--worktree', '10', '--surface', '5', '--json'],
    { runtime: setup.runtime, cwd: setup.feature },
  );
  assert.equal(run.code, 0, run.stdout);
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    runId: 77,
    workflowKey: 'implement-story',
    origin: { worktreeId: 10, surfaceId: 5 },
    placement: null,
  });
  assert.deepEqual(
    setup.runtime.calls.map((call) => call.endpointId),
    ['workflows.start'],
  );
  assert.deepEqual(setup.runtime.calls[0]!.args, [
    { workflowKey: 'implement-story', origin: { worktreeId: 10, surfaceId: 5 } },
  ]);
});

test('launch sends inputs from a file and echoes the requested placement', async () => {
  const setup = workspace();
  writeFileSync(join(setup.feature, 'inputs.json'), '{"story": 47, "notes": "a:b"}');
  const run = await runIsagi(
    [
      'runs',
      'launch',
      'implement-story',
      '--inputs',
      '@inputs.json',
      '--worktree-placement',
      'existing:31',
      '--surface-placement',
      'create:Experiment: retry phase 2',
      '--json',
    ],
    { runtime: setup.runtime, cwd: setup.feature },
  );
  assert.equal(run.code, 0, run.stdout);
  const placement = {
    worktree: { kind: 'existing', worktreeId: 31 },
    surface: { kind: 'create', title: 'Experiment: retry phase 2' },
  };
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    runId: 77,
    workflowKey: 'implement-story',
    origin: { worktreeId: 11, surfaceId: 111 },
    placement,
  });
  const start = setup.runtime.calls.find((call) => call.endpointId === 'workflows.start')!;
  assert.deepEqual(start.args, [
    {
      workflowKey: 'implement-story',
      origin: { worktreeId: 11, surfaceId: 111 },
      inputs: { story: 47, notes: 'a:b' },
      placement,
    },
  ]);
});

test('invalid, non-object or unreadable --inputs is a usage error before any request', async () => {
  for (const inputs of ['{not json', '[1,2]', 'null', '"text"', '@missing.json']) {
    const setup = workspace();
    const run = await runIsagi(
      ['runs', 'launch', 'implement-story', '--inputs', inputs, '--json'],
      {
        runtime: setup.runtime,
        cwd: setup.feature,
      },
    );
    assert.equal(run.code, 2, inputs);
    const { error } = onlyJsonDocument(run.stdout) as { error: { code: string } };
    assert.equal(error.code, 'cli_usage_invalid', inputs);
    assert.deepEqual(setup.runtime.calls, [], inputs);
  }
});

test("the runtime's own launch rejection passes through unchanged", async () => {
  const setup = workspace();
  const runtime = fakeRuntime({
    'workflows.start': () =>
      fail(
        new RuntimeApiError({
          code: 'workflow_rejected',
          status: 409,
          message: 'The origin worktree is not in the checkpoint project.',
          requestId: 'req-9',
          data: { reason: 'workflow_launch_context_mismatch' },
        } as never),
      ),
  });
  const run = await runIsagi(
    ['runs', 'launch', 'implement-story', '--worktree', '10', '--surface', '5', '--json'],
    { runtime, cwd: setup.feature },
  );
  assert.equal(run.code, 1);
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    error: {
      code: 'workflow_rejected',
      reason: 'workflow_launch_context_mismatch',
      message: 'The origin worktree is not in the checkpoint project.',
      requestId: 'req-9',
      data: { reason: 'workflow_launch_context_mismatch' },
    },
  });
});
