import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from '@isagi/runtime-client';

import { commandTable } from './commands/table.js';
import { cliErrorCodeSchema } from './errors.js';
import {
  fail,
  fakeRuntime,
  minimalArgv,
  onlyJsonDocument,
  runIsagi,
} from './testing/cli-harness.js';

const page = { items: [], nextCursor: null };

test('with --json, stdout holds exactly one document: the result', async () => {
  const runtime = fakeRuntime({
    'workflows.listRuns': () => ({ items: [{ runId: 1 }], nextCursor: 2 }),
  });
  const run = await runIsagi(['runs', 'list', '--json'], { runtime });
  assert.equal(run.code, 0);
  assert.deepEqual(onlyJsonDocument(run.stdout), { items: [{ runId: 1 }], nextCursor: 2 });
  assert.equal(run.stderr, '');
});

test('without --json, a result prints as indented JSON', async () => {
  const runtime = fakeRuntime({ 'workflows.getRun': () => ({ run: { runId: 3 } }) });
  const run = await runIsagi(['runs', 'show', '3'], { runtime });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, `${JSON.stringify({ run: { runId: 3 } }, null, 2)}\n`);
});

test('a usage error exits 2 before any request, as one JSON document under --json', async () => {
  const runtime = fakeRuntime({});
  const run = await runIsagi(['runs', 'show', 'nope', '--json'], { runtime });
  assert.equal(run.code, 2);
  assert.equal(runtime.calls.length, 0);
  const document = onlyJsonDocument(run.stdout) as { error: { code: string } };
  assert.equal(document.error.code, 'cli_usage_invalid');

  const plain = await runIsagi(['runs', 'show', 'nope'], { runtime });
  assert.equal(plain.code, 2);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /^isagi: cli_usage_invalid: <runId> must be a positive integer/);
});

test('--help prints usage to stdout and exits 0, even with --json', async () => {
  const run = await runIsagi(['runs', 'list', '--help', '--json']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /^Usage: isagi runs list/);
});

test('an API failure keeps its code and lifts its reason, request id and data', async () => {
  const data = { reason: 'workflow_run_not_found', runId: 9 };
  const runtime = fakeRuntime({
    'workflows.getRun': () =>
      fail(
        new RuntimeApiError({
          code: 'workflow_rejected',
          status: 404,
          message: 'Run 9 does not exist.',
          requestId: 'req-9',
          data,
        } as never),
      ),
  });

  const run = await runIsagi(['runs', 'show', '9', '--json'], { runtime });
  assert.equal(run.code, 1);
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    error: {
      code: 'workflow_rejected',
      reason: 'workflow_run_not_found',
      message: 'Run 9 does not exist.',
      requestId: 'req-9',
      data,
    },
  });

  const plain = await runIsagi(['runs', 'show', '9'], { runtime });
  assert.equal(plain.stdout, '');
  assert.equal(
    plain.stderr,
    'isagi: workflow_rejected (workflow_run_not_found): Run 9 does not exist.\n',
  );
});

test('a transport failure is runtime_unreachable, naming the endpoint and runtime', async () => {
  const cause = Object.assign(new TypeError('fetch failed'), {
    cause: new Error('connect ECONNREFUSED 127.0.0.1:4100'),
  });
  const runtime = fakeRuntime({
    'workflows.listRuns': () =>
      fail(new RuntimeTransportError('Could not reach runtime endpoint.', cause)),
  });
  const run = await runIsagi(['runs', 'list', '--json'], { runtime });
  assert.equal(run.code, 1);
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    error: {
      code: 'runtime_unreachable',
      message: 'Could not reach the Isagi runtime at http://127.0.0.1:4100/.',
      data: {
        endpointId: 'workflows.listRuns',
        runtimeUrl: 'http://127.0.0.1:4100/',
        cause: 'fetch failed: connect ECONNREFUSED 127.0.0.1:4100',
      },
    },
  });
});

test('a response that breaks the contract is runtime_response_invalid', async () => {
  const runtime = fakeRuntime({
    'workflows.listRuns': () =>
      fail(new RuntimeDecodeError('workflows.listRuns', new Error('bad'))),
  });
  const run = await runIsagi(['runs', 'list', '--json'], { runtime });
  assert.equal(run.code, 1);
  const document = onlyJsonDocument(run.stdout) as { error: { code: string; data: unknown } };
  assert.equal(document.error.code, 'runtime_response_invalid');
  assert.deepEqual(document.error.data, { endpointId: 'workflows.listRuns' });
});

test('targeting: --runtime-url beats ISAGI_RUNTIME_URL; neither is runtime_unconfigured', async () => {
  const runtime = fakeRuntime({ 'workflows.listRuns': () => page });
  const seen: string[] = [];
  const recording = {
    ...runtime,
    layer: (url: string) => {
      seen.push(url);
      return runtime.layer(url);
    },
  };

  await runIsagi(['runs', 'list', '--runtime-url', 'http://127.0.0.1:5000'], {
    runtime: recording,
    env: { ISAGI_RUNTIME_URL: 'http://127.0.0.1:4100' },
  });
  await runIsagi(['runs', 'list'], {
    runtime: recording,
    env: { ISAGI_RUNTIME_URL: 'http://127.0.0.1:4100' },
  });
  assert.deepEqual(seen, ['http://127.0.0.1:5000/', 'http://127.0.0.1:4100/']);

  const unconfigured = await runIsagi(['runs', 'list', '--json'], { runtime, env: {} });
  assert.equal(unconfigured.code, 1);
  const document = onlyJsonDocument(unconfigured.stdout) as { error: { code: string } };
  assert.equal(document.error.code, 'runtime_unconfigured');
});

test('targeting refuses a URL with credentials or another scheme, without echoing it', async () => {
  for (const url of ['http://user:secret@127.0.0.1:4100', 'file:///tmp/x', 'not a url']) {
    for (const env of [{}, { ISAGI_RUNTIME_URL: url }]) {
      const argv =
        'ISAGI_RUNTIME_URL' in env
          ? ['runs', 'list', '--json']
          : ['runs', 'list', '--json', '--runtime-url', url];
      const run = await runIsagi(argv, { env, runtime: fakeRuntime({}) });
      assert.equal(run.code, 2, url);
      const document = onlyJsonDocument(run.stdout) as { error: { code: string } };
      assert.equal(document.error.code, 'cli_usage_invalid');
      assert.ok(!run.stdout.includes('secret'));
    }
  }
});

test('every command that is not composed issues exactly one request', async () => {
  const composed = new Set([
    // Origin resolution reads the workspace snapshot unless --worktree and --surface are given.
    'workflows list',
    'runs launch',
  ]);
  for (const spec of commandTable) {
    const id = `${spec.group} ${spec.verb}`;
    if (composed.has(id)) continue;
    const runtime = fakeRuntime(
      new Proxy({}, { get: () => () => page }),
      new Proxy({}, { get: () => () => new Response('') }),
    );
    const run = await runIsagi([...minimalArgv(spec), '--json'], { runtime });
    assert.equal(run.code, 0, `${id}: ${run.stdout}${run.stderr}`);
    assert.equal(runtime.calls.length, 1, id);
  }
});

test('commands pass their flags to the route they name', async () => {
  const cases: readonly [readonly string[], string, readonly unknown[]][] = [
    [
      ['runs', 'list', '--workflow', 'implement-story', '--status', 'failed', '--limit', '5'],
      'workflows.listRuns',
      [{ workflowKey: 'implement-story', status: 'failed', limit: 5 }],
    ],
    [['runs', 'show', '4'], 'workflows.getRun', [{ runId: 4 }]],
    [
      ['runs', 'structure', '4', '--artifact-hash', 'sha256:abc'],
      'workflows.getStructure',
      [{ runId: 4 }, { artifactHash: 'sha256:abc' }],
    ],
    [
      ['runs', 'events', '4', '--cursor', '120', '--limit', '50'],
      'workflows.listEvents',
      [{ runId: 4 }, { cursor: 120, limit: 50 }],
    ],
    [['runs', 'pause', '4'], 'workflows.pause', [{ runId: 4 }]],
    [['runs', 'resume', '4'], 'workflows.resume', [{ runId: 4 }]],
    [['runs', 'retry', '4'], 'workflows.retry', [{ runId: 4 }]],
    [['runs', 'cancel', '4'], 'workflows.cancel', [{ runId: 4 }]],
    [['executions', 'show', '137'], 'workflows.getExecution', [{ executionId: 137 }]],
    [
      ['operations', 'list', '--run', '42', '--session', '9', '--execution', '137'],
      'workflows.listOperations',
      [{ runId: 42 }, { agentSessionId: 9, executionId: 137 }],
    ],
    [['operations', 'show', '31'], 'workflows.getOperation', [{ operationId: 31 }]],
    [
      ['checkpoints', 'list', '--run', '42', '--scope', 'plan', '--execution', '137'],
      'workflows.listCheckpoints',
      [{ runId: 42 }, { scope: 'plan', executionId: 137 }],
    ],
    [['checkpoints', 'show', '5'], 'workflows.getCheckpoint', [{ checkpointId: 5 }]],
  ];
  for (const [argv, endpointId, args] of cases) {
    const runtime = fakeRuntime({ [endpointId]: () => page });
    const run = await runIsagi(argv, { runtime });
    assert.equal(run.code, 0, `${argv.join(' ')}: ${run.stderr}`);
    assert.deepEqual(runtime.calls, [{ endpointId, args }], argv.join(' '));
  }
});

test('the CLI-owned error codes are exactly the 6 the CLI documents', () => {
  assert.deepEqual([...cliErrorCodeSchema.literals].sort(), [
    'cli_usage_invalid',
    'filesystem_write_failed',
    'origin_unresolved',
    'runtime_response_invalid',
    'runtime_unconfigured',
    'runtime_unreachable',
  ]);
});
