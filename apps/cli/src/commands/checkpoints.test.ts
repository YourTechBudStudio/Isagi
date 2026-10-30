import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import { RuntimeApiError } from '@isagi/runtime-client';

import {
  content,
  cutContent,
  fail,
  fakeRuntime,
  onlyJsonDocument,
  runIsagi,
} from '../testing/cli-harness.js';

const runtimeUrl = { value: 'http://127.0.0.1:4100/', source: 'env', name: 'ISAGI_RUNTIME_URL' };

test('checkpoints read writes the captured bytes, unchanged, to stdout', async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x41]);
  const runtime = fakeRuntime({}, { 'workflows.getCheckpointFile': () => content(bytes) });
  const run = await runIsagi(
    ['workflows', 'checkpoints', 'read', '5', 'scratch/plan.md', '--json'],
    {
      runtime,
    },
  );
  assert.equal(run.code, 0);
  assert.deepEqual(run.stdoutBytes, bytes);
  assert.deepEqual(runtime.calls, [
    {
      endpointId: 'workflows.getCheckpointFile',
      args: [{ checkpointId: 5 }, { path: 'scratch/plan.md' }],
    },
  ]);
});

test('a refused read prints its error on stderr, never on the byte stream', async () => {
  const runtime = fakeRuntime(
    {},
    {
      'workflows.getCheckpointFile': () =>
        fail(
          new RuntimeApiError({
            endpointId: 'workflows.getCheckpointFile',
            apiError: {
              code: 'workflow_rejected',
              status: 400,
              message: 'Checkpoint 5 has no captured file.',
              requestId: 'r',
              data: { reason: 'workflow_checkpoint_file_not_found', checkpointId: 5, path: 'x' },
            },
          }),
        ),
    },
  );
  const run = await runIsagi(['workflows', 'checkpoints', 'read', '5', 'x', '--json'], { runtime });
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  const document = JSON.parse(run.stderr) as { error: { reason: string } };
  assert.equal(document.error.reason, 'workflow_checkpoint_file_not_found');
});

test('a refused checkpoints read command line also keeps stdout for bytes only', async () => {
  const runtime = fakeRuntime({});
  for (const argv of [
    ['workflows', 'checkpoints', 'read', 'nope', 'a.md', '--json'],
    ['workflows', 'checkpoints', 'read', '5', '--json'],
    ['workflows', 'checkpoints', 'read', '5', 'a.md', '--bogus', '--json'],
  ]) {
    const run = await runIsagi(argv, { runtime });
    assert.equal(run.code, 2, argv.join(' '));
    assert.equal(run.stdout, '', argv.join(' '));
    const document = JSON.parse(run.stderr) as { error: { code: string; recovery: string } };
    assert.equal(document.error.code, 'cli_usage_invalid');
    assert.match(document.error.recovery, /`isagi workflows checkpoints read --help`/);
  }
  assert.equal(runtime.calls.length, 0);
});

test('a checkpoints read with no runtime URL reports it on stderr, never on the byte stream', async () => {
  const run = await runIsagi(['workflows', 'checkpoints', 'read', '5', 'a.md', '--json'], {
    env: {},
  });
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  const document = JSON.parse(run.stderr) as { error: { code: string } };
  assert.equal(document.error.code, 'runtime_unconfigured');
});

test('a read cut part-way is runtime_unreachable on stderr, after the bytes that arrived', async () => {
  const cause = Object.assign(new TypeError('terminated'), {
    cause: new Error('other side closed'),
  });
  const runtime = fakeRuntime(
    {},
    {
      'workflows.getCheckpointFile': () =>
        cutContent('workflows.getCheckpointFile', Buffer.from('partial'), cause),
    },
  );
  const run = await runIsagi(['workflows', 'checkpoints', 'read', '5', 'a.md', '--json'], {
    runtime,
  });
  assert.equal(run.code, 1);
  assert.equal(run.stdout, 'partial');
  assert.deepEqual(JSON.parse(run.stderr), {
    error: {
      code: 'runtime_unreachable',
      message: 'The checkpoint file stream failed part-way; stdout may be truncated.',
      recovery:
        'Check that the runtime at `context.runtimeUrl` is running. If the URL came from ISAGI_RUNTIME_URL in an old terminal, open a new Isagi terminal.',
      context: {
        checkpointId: 5,
        path: 'a.md',
        cause: 'terminated: other side closed',
        runtimeUrl,
      },
    },
  });
});

test('a reader that closes the pipe early is not a failure', async () => {
  const runtime = fakeRuntime(
    {},
    { 'workflows.getCheckpointFile': () => content('a lot of bytes') },
  );
  const closed = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    },
  });
  const run = await runIsagi(['workflows', 'checkpoints', 'read', '5', 'a.md'], {
    runtime,
    stdout: closed,
  });
  assert.equal(run.code, 0);
});

test('checkpoints export is one runtime call with the folder resolved against the cwd', async () => {
  const output = { destinationPath: '/work/rebuilt', worktreeId: 31 };
  const runtime = fakeRuntime({ 'workflows.exportCheckpoint': () => output });
  const run = await runIsagi(
    ['workflows', 'checkpoints', 'export', '5', '--output', '../rebuilt', '--json'],
    {
      runtime,
      cwd: '/work/project',
    },
  );
  assert.equal(run.code, 0);
  assert.deepEqual(onlyJsonDocument(run.stdout), output);
  assert.deepEqual(runtime.calls, [
    {
      endpointId: 'workflows.exportCheckpoint',
      args: [{ checkpointId: 5 }, { destinationPath: '/work/rebuilt' }],
    },
  ]);
});

test('an export the runtime refuses is its error document and exit 1', async () => {
  const data = {
    reason: 'workflow_checkpoint_commit_unavailable',
    checkpointId: 5,
    commitSha: 'f'.repeat(40),
  };
  const runtime = fakeRuntime({
    'workflows.exportCheckpoint': () =>
      fail(
        new RuntimeApiError({
          endpointId: 'workflows.exportCheckpoint',
          apiError: {
            code: 'workflow_rejected',
            status: 409,
            message: 'The commit is gone.',
            requestId: 'r',
            data,
          },
        }),
      ),
  });
  const run = await runIsagi(
    ['workflows', 'checkpoints', 'export', '5', '--output', '/x', '--json'],
    {
      runtime,
    },
  );
  assert.equal(run.code, 1);
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    error: {
      code: 'workflow_rejected',
      message: 'The commit is gone.',
      recovery:
        'Read `reason` and `data` for what the runtime refused; correct the request, or report `requestId`.',
      context: { endpointId: 'workflows.exportCheckpoint', runtimeUrl },
      reason: 'workflow_checkpoint_commit_unavailable',
      requestId: 'r',
      data,
    },
  });
});
