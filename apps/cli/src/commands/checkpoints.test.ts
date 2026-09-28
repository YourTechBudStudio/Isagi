import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import { RuntimeApiError } from '@isagi/runtime-client';

import { fail, fakeRuntime, onlyJsonDocument, runIsagi } from '../testing/cli-harness.js';

test('checkpoints read writes the captured bytes, unchanged, to stdout', async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x41]);
  const runtime = fakeRuntime(
    {},
    { 'workflows.getCheckpointFile': () => new Response(bytes, { status: 200 }) },
  );
  const run = await runIsagi(['checkpoints', 'read', '5', 'scratch/plan.md', '--json'], {
    runtime,
  });
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
            code: 'workflow_rejected',
            status: 400,
            message: 'Checkpoint 5 has no captured file.',
            requestId: 'r',
            data: { reason: 'workflow_checkpoint_file_not_found', checkpointId: 5, path: 'x' },
          } as never),
        ),
    },
  );
  const run = await runIsagi(['checkpoints', 'read', '5', 'x', '--json'], { runtime });
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  const document = JSON.parse(run.stderr) as { error: { reason: string } };
  assert.equal(document.error.reason, 'workflow_checkpoint_file_not_found');
});

test('a refused checkpoints read command line also keeps stdout for bytes only', async () => {
  const runtime = fakeRuntime({});
  const run = await runIsagi(['checkpoints', 'read', 'nope', 'a.md', '--json'], { runtime });
  assert.equal(run.code, 2);
  assert.equal(run.stdout, '');
  const document = JSON.parse(run.stderr) as { error: { code: string } };
  assert.equal(document.error.code, 'cli_usage_invalid');
});

test('a reader that closes the pipe early is not a failure', async () => {
  const runtime = fakeRuntime(
    {},
    { 'workflows.getCheckpointFile': () => new Response('a lot of bytes', { status: 200 }) },
  );
  const closed = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    },
  });
  const run = await runIsagi(['checkpoints', 'read', '5', 'a.md'], { runtime, stdout: closed });
  assert.equal(run.code, 0);
});

test('checkpoints export is one runtime call with the folder resolved against the cwd', async () => {
  const output = { destinationPath: '/work/rebuilt', worktreeId: 31 };
  const runtime = fakeRuntime({ 'workflows.exportCheckpoint': () => output });
  const run = await runIsagi(['checkpoints', 'export', '5', '--output', '../rebuilt', '--json'], {
    runtime,
    cwd: '/work/project',
  });
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
          code: 'workflow_rejected',
          status: 409,
          message: 'The commit is gone.',
          requestId: 'r',
          data,
        } as never),
      ),
  });
  const run = await runIsagi(['checkpoints', 'export', '5', '--output', '/x', '--json'], {
    runtime,
  });
  assert.equal(run.code, 1);
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    error: {
      code: 'workflow_rejected',
      reason: 'workflow_checkpoint_commit_unavailable',
      message: 'The commit is gone.',
      requestId: 'r',
      data,
    },
  });
});
