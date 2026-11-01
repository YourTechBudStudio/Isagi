import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from '@isagi/runtime-client';

import { cliErrorCodeSchema } from './errors.js';
import { splitJsonFlag } from './main.js';
import {
  content,
  fail,
  fakeRuntime,
  fakeRuntimeEntry,
  minimalCommandLines,
  onlyJsonDocument,
  runIsagi,
} from './testing/cli-harness.js';

const page = { items: [], nextCursor: null };
const envRuntimeUrl = { value: 'http://127.0.0.1:4100/', source: 'env', name: 'ISAGI_RUNTIME_URL' };

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly recovery: string;
  readonly context: Record<string, unknown>;
}

/** The one error document a `--json` run printed on stdout, with the four fields every one has. */
function errorDocument(stdout: string): ErrorBody {
  const document = onlyJsonDocument(stdout) as { error: ErrorBody };
  assert.deepEqual(Object.keys(document), ['error']);
  const { error } = document;
  assert.ok(typeof error.code === 'string' && error.code !== '');
  assert.ok(typeof error.message === 'string' && error.message !== '');
  assert.ok(typeof error.recovery === 'string' && error.recovery !== '');
  assert.ok(error.context !== null && typeof error.context === 'object');
  return error;
}

test('with --json, stdout holds exactly one document: the result', async () => {
  const runtime = fakeRuntime({
    'workflows.listRuns': () => ({ items: [{ runId: 1 }], nextCursor: 2 }),
  });
  const run = await runIsagi(['workflows', 'runs', 'list', '--json'], { runtime });
  assert.equal(run.code, 0);
  assert.deepEqual(onlyJsonDocument(run.stdout), { items: [{ runId: 1 }], nextCursor: 2 });
  assert.equal(run.stderr, '');
});

test('without --json, a result prints as indented JSON', async () => {
  const runtime = fakeRuntime({ 'workflows.getRun': () => ({ run: { runId: 3 } }) });
  const run = await runIsagi(['workflows', 'runs', 'show', '3'], { runtime });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, `${JSON.stringify({ run: { runId: 3 } }, null, 2)}\n`);
});

test('--json is read anywhere before --, and a following word is never its value', async () => {
  assert.deepEqual(splitJsonFlag(['--json', 'workflows', 'runs', 'show', '1']), {
    json: true,
    rest: ['workflows', 'runs', 'show', '1'],
  });
  assert.deepEqual(splitJsonFlag(['workflows', '--', '--json']), {
    json: false,
    rest: ['workflows', '--', '--json'],
  });
  const runtime = fakeRuntime({ 'workflows.getRun': () => ({ run: { runId: 1 } }) });
  const run = await runIsagi(['workflows', 'runs', 'show', '--json', '1'], { runtime });
  assert.equal(run.code, 0, run.stdout);
  assert.deepEqual(runtime.calls, [{ endpointId: 'workflows.getRun', args: [{ runId: 1 }] }]);
});

test('--help prints usage to stdout and exits 0, even with --json', async () => {
  const run = await runIsagi(['workflows', 'runs', 'list', '--help', '--json']);
  assert.equal(run.code, 0);
  assert.equal(run.stderr, '');
  assert.match(run.stdout, /^ {2}isagi workflows runs list \[flags\]$/m);
});

test('--help on a refused line prints help only, never help and an error document', async () => {
  const run = await runIsagi(['nope', '--help', '--json']);
  assert.equal(run.code, 0);
  assert.equal(run.stderr, '');
  assert.match(run.stdout, /^USAGE$/m);
  assert.doesNotMatch(run.stdout, /"error"/);
});

/**
 * Every failure class under --json: exactly one document with code, message, recovery and context
 * on stdout, nothing on stderr. Without --json: the message line and the recovery line on stderr.
 */
test('every failure is one error document under --json, and two stderr lines without it', async () => {
  const failingEntry = fakeRuntimeEntry({
    load: () => Promise.reject(new Error("Cannot find module './index.js'")),
  }).entry;
  const transport = () =>
    fakeRuntime({
      'workflows.listRuns': () =>
        fail(
          new RuntimeTransportError({
            endpointId: 'workflows.listRuns',
            cause: new TypeError('fetch failed'),
          }),
        ),
    });
  const cases: ReadonlyArray<{
    readonly argv: readonly string[];
    readonly code: string;
    readonly exit: number;
    readonly env?: Readonly<Record<string, string>>;
    readonly runtime?: ReturnType<typeof fakeRuntime>;
  }> = [
    { argv: ['nope'], code: 'cli_usage_invalid', exit: 2 },
    { argv: ['workflows', 'runs', 'lst'], code: 'cli_usage_invalid', exit: 2 },
    { argv: ['workflows', 'runs', 'list', '--limt', '5'], code: 'cli_usage_invalid', exit: 2 },
    { argv: ['workflows', 'runs', 'list', '--limit', 'abc'], code: 'cli_usage_invalid', exit: 2 },
    { argv: ['workflows', 'operations', 'list'], code: 'cli_usage_invalid', exit: 2 },
    { argv: ['workflows', 'runs', 'show'], code: 'cli_usage_invalid', exit: 2 },
    { argv: ['workflows', 'runs', 'show', '1', '2'], code: 'cli_usage_invalid', exit: 2 },
    { argv: ['workflows', 'runs'], code: 'cli_usage_invalid', exit: 2 },
    { argv: [], code: 'cli_usage_invalid', exit: 2 },
    { argv: ['workflows', 'list', '--surface', '3'], code: 'cli_usage_invalid', exit: 2 },
    { argv: ['workflows', 'runs', 'list'], code: 'runtime_unconfigured', exit: 1, env: {} },
    {
      argv: ['workflows', 'runs', 'list'],
      code: 'runtime_unreachable',
      exit: 1,
      runtime: transport(),
    },
    { argv: ['serve'], code: 'cli_usage_invalid', exit: 2, env: { ISAGI_PORT: '80a' } },
    { argv: ['serve'], code: 'runtime_load_failed', exit: 1, env: {} },
  ];
  for (const { argv, code, exit, env, runtime } of cases) {
    const options = {
      runtimeEntry: failingEntry,
      ...(env === undefined ? {} : { env }),
      ...(runtime === undefined ? {} : { runtime }),
    };
    const line = argv.join(' ') || '(nothing)';
    const json = await runIsagi([...argv, '--json'], options);
    assert.equal(json.code, exit, line);
    assert.equal(json.stderr, '', line);
    assert.equal(errorDocument(json.stdout).code, code, line);

    const plain = await runIsagi(argv, options);
    assert.equal(plain.code, exit, line);
    assert.equal(plain.stdout, '', line);
    const lines = plain.stderr.split('\n');
    assert.equal(lines.length, 3, `${line}: ${plain.stderr}`);
    assert.match(lines[0]!, new RegExp(`^isagi: ${code}( \\([a-z_]+\\))?: `), line);
    assert.match(lines[1]!, /^ {2}\S/, line);
  }
});

test('a usage error names the closest command, the help to run, and the valid names', async () => {
  const unknownVerb = errorDocument(
    (await runIsagi(['workflows', 'runs', 'lst', '--json'])).stdout,
  );
  assert.deepEqual(unknownVerb, {
    code: 'cli_usage_invalid',
    message: 'Unknown command "lst" for "isagi workflows runs".',
    recovery:
      'Did you mean `isagi workflows runs list`? `isagi workflows runs --help` lists every runs command with examples.',
    context: {
      command: 'isagi workflows runs',
      unknown: 'lst',
      suggestions: ['list'],
      validCommands: [
        'launch',
        'list',
        'show',
        'structure',
        'events',
        'pause',
        'resume',
        'retry',
        'cancel',
      ],
    },
  });

  const nested = errorDocument(
    (await runIsagi(['workflows', 'checkpoints', 'raed', '--json'])).stdout,
  );
  assert.equal(
    nested.recovery,
    'Did you mean `isagi workflows checkpoints read`? `isagi workflows checkpoints --help` lists every checkpoints command with examples.',
  );

  const unknownFlag = errorDocument(
    (await runIsagi(['workflows', 'runs', 'list', '--limt', '5', '--json'])).stdout,
  );
  assert.equal(unknownFlag.message, 'Unknown flag "--limt" for "isagi workflows runs list".');
  assert.equal(
    unknownFlag.recovery,
    'Did you mean `--limit`? `isagi workflows runs list --help` lists its flags with examples.',
  );
  assert.deepEqual(unknownFlag.context.suggestions, ['--limit']);
  assert.ok((unknownFlag.context.validFlags as string[]).includes('--json'));
  assert.ok((unknownFlag.context.validFlags as string[]).includes('--runtime-url'));

  const invalid = errorDocument(
    (await runIsagi(['workflows', 'runs', 'list', '--limit', 'abc', '--json'])).stdout,
  );
  assert.equal(
    invalid.message,
    '--limit must be a page size the runtime accepts (1–500), got "abc".',
  );
  assert.equal(invalid.context.flag, '--limit');

  const missing = errorDocument((await runIsagi(['workflows', 'runs', '--json'])).stdout);
  assert.equal(missing.message, 'Missing a command after "isagi workflows runs".');
  assert.ok(Array.isArray(missing.context.validCommands));

  const bareWorkflows = errorDocument((await runIsagi(['workflows', '--json'])).stdout);
  assert.equal(bareWorkflows.message, 'Missing a command after "isagi workflows".');
  assert.deepEqual(bareWorkflows.context.validCommands, [
    'list',
    'runs',
    'executions',
    'operations',
    'checkpoints',
  ]);
});

test('an old root spelling is an unknown command pointing at isagi workflows', async () => {
  for (const argv of [['runs', 'list'], ['checkpoints', 'show', '5'], []]) {
    const error = errorDocument((await runIsagi([...argv, '--json'])).stdout);
    assert.equal(error.code, 'cli_usage_invalid');
    assert.ok(
      error.recovery.endsWith('Client commands live under `isagi workflows`.'),
      error.recovery,
    );
    assert.deepEqual(error.context.validCommands, ['serve', 'workflows']);
  }
});

test('an API failure keeps its code and lifts its reason, request id and data', async () => {
  const data = { reason: 'workflow_run_not_found', runId: 9 };
  const runtime = fakeRuntime({
    'workflows.getRun': () =>
      fail(
        new RuntimeApiError({
          endpointId: 'workflows.getRun',
          apiError: {
            code: 'workflow_rejected',
            status: 404,
            message: 'Run 9 does not exist.',
            requestId: 'req-9',
            data,
          },
        }),
      ),
  });

  const run = await runIsagi(['workflows', 'runs', 'show', '9', '--json'], { runtime });
  assert.equal(run.code, 1);
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    error: {
      code: 'workflow_rejected',
      message: 'Run 9 does not exist.',
      recovery:
        'Read `reason` and `data` for what the runtime refused; correct the request, or report `requestId`.',
      context: { endpointId: 'workflows.getRun', runtimeUrl: envRuntimeUrl },
      reason: 'workflow_run_not_found',
      requestId: 'req-9',
      data,
    },
  });

  const plain = await runIsagi(['workflows', 'runs', 'show', '9'], { runtime });
  assert.equal(plain.stdout, '');
  assert.equal(
    plain.stderr,
    'isagi: workflow_rejected (workflow_run_not_found): Run 9 does not exist.\n  Read `reason` and `data` for what the runtime refused; correct the request, or report `requestId`.\n',
  );
});

test('a route the runtime does not serve points at the matching isagi', async () => {
  const runtime = fakeRuntime({
    'workflows.getRun': () =>
      fail(
        new RuntimeApiError({
          endpointId: 'workflows.getRun',
          apiError: {
            code: 'api_route_not_found',
            status: 404,
            message: 'Not found.',
            requestId: 'r',
          },
        }),
      ),
  });
  const run = await runIsagi(['workflows', 'runs', 'show', '9', '--json'], { runtime });
  assert.match(
    errorDocument(run.stdout).recovery,
    /use the `isagi` on PATH inside an Isagi terminal/,
  );
});

test('a Host the runtime refuses points at server.allowedHosts', async () => {
  const runtime = fakeRuntime({
    'workflows.getRun': () =>
      fail(
        new RuntimeApiError({
          endpointId: 'workflows.getRun',
          apiError: {
            code: 'api_host_not_allowed',
            status: 403,
            message: 'Requests for host "192.168.1.20" are not allowed.',
            requestId: 'r',
            data: { host: '192.168.1.20:11299' },
          },
        }),
      ),
  });
  const run = await runIsagi(['workflows', 'runs', 'show', '9', '--json'], { runtime });
  assert.equal(run.code, 1);
  const error = errorDocument(run.stdout);
  assert.equal(error.code, 'api_host_not_allowed');
  assert.equal(
    error.recovery,
    "The runtime refused the request's Host (`data.host`). Add that host to server.allowedHosts in the runtime's config.yaml and restart the runtime; a runtime listening on a specific non-loopback address must list that address.",
  );
});

test('a transport failure is runtime_unreachable, naming the endpoint and runtime', async () => {
  const cause = Object.assign(new TypeError('fetch failed'), {
    cause: new Error('connect ECONNREFUSED 127.0.0.1:4100'),
  });
  const runtime = fakeRuntime({
    'workflows.listRuns': () =>
      fail(new RuntimeTransportError({ endpointId: 'workflows.listRuns', cause })),
  });
  const run = await runIsagi(['workflows', 'runs', 'list', '--json'], { runtime });
  assert.equal(run.code, 1);
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    error: {
      code: 'runtime_unreachable',
      message: 'Could not reach the Isagi runtime at http://127.0.0.1:4100/.',
      recovery:
        'Check that the runtime at `context.runtimeUrl` is running. If the URL came from ISAGI_RUNTIME_URL in an old terminal, open a new Isagi terminal.',
      context: {
        endpointId: 'workflows.listRuns',
        cause: 'fetch failed: connect ECONNREFUSED 127.0.0.1:4100',
        runtimeUrl: envRuntimeUrl,
      },
    },
  });
});

test('a response that breaks the contract is runtime_response_invalid', async () => {
  const runtime = fakeRuntime({
    'workflows.listRuns': () =>
      fail(new RuntimeDecodeError({ endpointId: 'workflows.listRuns', cause: new Error('bad') })),
  });
  const run = await runIsagi(['workflows', 'runs', 'list', '--json'], { runtime });
  assert.equal(run.code, 1);
  const error = errorDocument(run.stdout);
  assert.equal(error.code, 'runtime_response_invalid');
  assert.deepEqual(error.context, { endpointId: 'workflows.listRuns', runtimeUrl: envRuntimeUrl });
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

  await runIsagi(['workflows', 'runs', 'list', '--runtime-url', 'http://127.0.0.1:5000'], {
    runtime: recording,
    env: { ISAGI_RUNTIME_URL: 'http://127.0.0.1:4100' },
  });
  await runIsagi(['workflows', 'runs', 'list'], {
    runtime: recording,
    env: { ISAGI_RUNTIME_URL: 'http://127.0.0.1:4100' },
  });
  // An empty environment variable is unset.
  const empty = await runIsagi(['workflows', 'runs', 'list', '--json'], {
    runtime,
    env: { ISAGI_RUNTIME_URL: '' },
  });
  assert.deepEqual(seen, ['http://127.0.0.1:5000/', 'http://127.0.0.1:4100/']);

  const unconfigured = await runIsagi(['workflows', 'runs', 'list', '--json'], {
    runtime,
    env: {},
  });
  assert.equal(unconfigured.code, 1);
  for (const run of [empty, unconfigured]) {
    const error = errorDocument(run.stdout);
    assert.equal(error.code, 'runtime_unconfigured');
    assert.deepEqual(error.context, { checked: ['--runtime-url', 'ISAGI_RUNTIME_URL'] });
  }
});

test('targeting refuses a URL with credentials or another scheme, without echoing it', async () => {
  for (const url of ['http://user:secret@127.0.0.1:4100', 'file:///tmp/x', 'not a url', '']) {
    for (const fromEnv of [false, true]) {
      if (fromEnv && url === '') continue;
      const argv = fromEnv
        ? ['workflows', 'runs', 'list', '--json']
        : ['workflows', 'runs', 'list', '--json', '--runtime-url', url];
      const run = await runIsagi(argv, {
        env: fromEnv ? { ISAGI_RUNTIME_URL: url } : {},
        runtime: fakeRuntime({}),
      });
      assert.equal(run.code, 2, url);
      const error = errorDocument(run.stdout);
      assert.equal(error.code, 'cli_usage_invalid');
      assert.deepEqual(error.context, {
        setting: 'runtimeUrl',
        source: fromEnv ? 'env' : 'flag',
        name: fromEnv ? 'ISAGI_RUNTIME_URL' : '--runtime-url',
      });
      assert.ok(!run.stdout.includes('secret'));
    }
  }
});

test('serve hands the resolved launch to the runtime entry and prints nothing', async () => {
  const runtime = fakeRuntimeEntry();
  const run = await runIsagi(
    ['serve', '--port', '11299', '--data-dir', 'data', '--allowed-origins', 'file://', '--json'],
    { runtimeEntry: runtime.entry, cwd: '/work', env: { ISAGI_HOST: '0.0.0.0' } },
  );
  assert.equal(run.code, 0, run.stdout);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
  assert.deepEqual(runtime.launches, [
    {
      host: { value: '0.0.0.0', source: 'env', name: 'ISAGI_HOST' },
      port: { value: 11299, source: 'flag', name: '--port' },
      dataDirectory: { value: '/work/data', source: 'flag', name: '--data-dir' },
      webRoot: undefined,
      allowedOrigins: ['file://'],
      cliEntryPath: '/opt/isagi/dist/isagi.mjs',
    },
  ]);
});

test('serve hands the entry’s bundled web root over as the default, and --web-root beats it', async () => {
  const runtime = fakeRuntimeEntry({ defaultWebRoot: '/opt/isagi/web' });
  await runIsagi(['serve'], { runtimeEntry: runtime.entry, cwd: '/work', env: {} });
  await runIsagi(['serve', '--web-root', 'web'], {
    runtimeEntry: runtime.entry,
    cwd: '/work',
    env: {},
  });
  assert.deepEqual(
    runtime.launches.map((launch) => launch.webRoot),
    [
      { value: '/opt/isagi/web', source: 'default', name: 'default' },
      { value: '/work/web', source: 'flag', name: '--web-root' },
    ],
  );
});

test('serve reports a bad setting before loading the runtime, and a load failure with its facts', async () => {
  let loaded = 0;
  const entry = fakeRuntimeEntry({
    load: () => {
      loaded += 1;
      return Promise.resolve({});
    },
  }).entry;
  const badPort = errorDocument(
    (await runIsagi(['serve', '--json'], { runtimeEntry: entry, env: { ISAGI_PORT: '80a' } }))
      .stdout,
  );
  assert.equal(loaded, 0);
  assert.deepEqual(badPort, {
    code: 'cli_usage_invalid',
    message: 'ISAGI_PORT must be a whole number from 0 to 65535, got "80a".',
    recovery: 'Set ISAGI_PORT to a whole number from 0 to 65535, or pass --port.',
    context: { port: { value: '80a', source: 'env', name: 'ISAGI_PORT' } },
  });

  const wrongShape = await runIsagi(['serve', '--json'], { runtimeEntry: entry, env: {} });
  assert.equal(wrongShape.code, 1);
  const error = errorDocument(wrongShape.stdout);
  assert.equal(error.code, 'runtime_load_failed');
  assert.deepEqual(Object.keys(error.context).sort(), [
    'arch',
    'cause',
    'entryPath',
    'node',
    'platform',
  ]);
  assert.equal(error.context.entryPath, '/opt/isagi/dist/isagi.mjs');
});

test('serve without a runtime entry is a defect, not a user error', async () => {
  await assert.rejects(runIsagi(['serve'], { env: {} }), /without a runtime entry/);
});

test('every command that is not composed issues exactly one request', async () => {
  const composed = new Set([
    // Origin resolution reads the workspace snapshot unless --worktree and --surface are given.
    'workflows list',
    'workflows runs launch',
  ]);
  for (const [command, rest] of Object.entries(minimalCommandLines)) {
    if (composed.has(command)) continue;
    const runtime = fakeRuntime(
      new Proxy({}, { get: () => () => page }),
      new Proxy({}, { get: () => () => content('') }),
    );
    const run = await runIsagi([...command.split(' '), ...rest, '--json'], { runtime });
    assert.equal(run.code, 0, `${command}: ${run.stdout}${run.stderr}`);
    assert.equal(runtime.calls.length, 1, command);
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
  for (const [rest, endpointId, args] of cases) {
    const argv = ['workflows', ...rest];
    const runtime = fakeRuntime({ [endpointId]: () => page });
    const run = await runIsagi(argv, { runtime });
    assert.equal(run.code, 0, `${argv.join(' ')}: ${run.stderr}`);
    assert.deepEqual(runtime.calls, [{ endpointId, args }], argv.join(' '));
  }
});

test('the CLI-owned error codes are exactly the 7 the CLI documents', () => {
  assert.deepEqual([...cliErrorCodeSchema.literals].sort(), [
    'cli_usage_invalid',
    'filesystem_write_failed',
    'origin_unresolved',
    'runtime_load_failed',
    'runtime_response_invalid',
    'runtime_unconfigured',
    'runtime_unreachable',
  ]);
});
