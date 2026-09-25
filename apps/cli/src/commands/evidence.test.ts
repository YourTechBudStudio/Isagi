import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { RuntimeApiError } from '@isagi/runtime-client';

import { fail, fakeRuntime, onlyJsonDocument, runIsagi } from '../testing/cli-harness.js';

// Deliberately not UTF-8, so a text round trip would corrupt it.
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a]);

function evidenceRecord(byteSize: number) {
  return {
    evidence: {
      evidenceKey: 'wev_1',
      content: {
        kind: 'file',
        mediaType: 'image/png',
        byteSize,
        contentRef: 'sha256:x',
        sourcePath: null,
      },
    },
  };
}

function contentRuntime(body: Buffer, byteSize = body.byteLength) {
  return fakeRuntime(
    { 'workflows.getEvidence': () => evidenceRecord(byteSize) },
    { 'workflows.getEvidenceContent': () => new Response(new Uint8Array(body)) },
  );
}

test('evidence read streams the raw bytes to stdout and nothing else', async () => {
  const runtime = contentRuntime(bytes);
  const run = await runIsagi(['evidence', 'read', 'wev_1', '--run', '42', '--json'], { runtime });
  assert.equal(run.code, 0);
  assert.deepEqual(run.stdoutBytes, bytes);
  assert.equal(run.stderr, '');
  assert.deepEqual(runtime.calls, [
    { endpointId: 'workflows.getEvidenceContent', args: [{ runId: 42, evidenceKey: 'wev_1' }] },
  ]);
});

test('an evidence read failure goes to stderr, never stdout, even with --json', async () => {
  const runtime = fakeRuntime(
    {},
    {
      'workflows.getEvidenceContent': () =>
        fail(
          new RuntimeApiError({
            code: 'workflow_rejected',
            status: 400,
            message: 'gone',
            requestId: 'r',
            data: {
              reason: 'workflow_evidence_content_unavailable',
              evidenceKey: 'wev_1',
              cause: 'missing',
            },
          } as never),
        ),
    },
  );
  const run = await runIsagi(['evidence', 'read', 'wev_1', '--run', '42', '--json'], { runtime });
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  const document = onlyJsonDocument(run.stderr) as { error: { reason: string } };
  assert.equal(document.error.reason, 'workflow_evidence_content_unavailable');
});

test('evidence export writes the bytes to a new file relative to the cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'isagi-cli-'));
  const runtime = contentRuntime(bytes);
  const run = await runIsagi(
    ['evidence', 'export', 'wev_1', '--run', '42', '--output', 'shot.png', '--json'],
    { runtime, cwd },
  );
  assert.equal(run.code, 0, run.stdout);
  const outputPath = join(cwd, 'shot.png');
  assert.deepEqual(onlyJsonDocument(run.stdout), {
    outputPath,
    ...evidenceRecord(bytes.byteLength),
  });
  assert.deepEqual(await readFile(outputPath), bytes);
});

test('evidence export refuses an existing file and leaves it untouched', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'isagi-cli-'));
  await writeFile(join(cwd, 'shot.png'), 'mine');
  const runtime = contentRuntime(bytes);
  const run = await runIsagi(
    ['evidence', 'export', 'wev_1', '--run', '42', '--output', 'shot.png', '--json'],
    { runtime, cwd },
  );
  assert.equal(run.code, 1);
  const document = onlyJsonDocument(run.stdout) as { error: { code: string } };
  assert.equal(document.error.code, 'output_exists');
  assert.equal(await readFile(join(cwd, 'shot.png'), 'utf8'), 'mine');
  assert.ok(!runtime.calls.some((call) => call.endpointId === 'workflows.getEvidenceContent'));
});

test('evidence export removes its own file when the byte count does not match', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'isagi-cli-'));
  const runtime = contentRuntime(bytes, bytes.byteLength + 1);
  const run = await runIsagi(
    ['evidence', 'export', 'wev_1', '--run', '42', '--output', 'shot.png', '--json'],
    { runtime, cwd },
  );
  assert.equal(run.code, 1);
  const document = onlyJsonDocument(run.stdout) as { error: { code: string; data: unknown } };
  assert.equal(document.error.code, 'content_integrity_mismatch');
  assert.deepEqual(document.error.data, {
    path: join(cwd, 'shot.png'),
    expectedBytes: bytes.byteLength + 1,
    receivedBytes: bytes.byteLength,
  });
  assert.deepEqual(await readdir(cwd), []);
});

test('evidence export removes its own file when the content request is refused', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'isagi-cli-'));
  const runtime = fakeRuntime(
    { 'workflows.getEvidence': () => evidenceRecord(4) },
    {
      'workflows.getEvidenceContent': () =>
        fail(
          new RuntimeApiError({
            code: 'workflow_rejected',
            status: 400,
            message: 'gone',
            requestId: 'r',
          } as never),
        ),
    },
  );
  const run = await runIsagi(['evidence', 'export', 'wev_1', '--run', '42', '--output', 'x.bin'], {
    runtime,
    cwd,
  });
  assert.equal(run.code, 1);
  assert.deepEqual(await readdir(cwd), []);
});

test('evidence export reports a directory it cannot write as filesystem_write_failed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'isagi-cli-'));
  const runtime = contentRuntime(bytes);
  const run = await runIsagi(
    ['evidence', 'export', 'wev_1', '--run', '42', '--output', 'missing/dir/x.bin', '--json'],
    { runtime, cwd },
  );
  assert.equal(run.code, 1);
  const document = onlyJsonDocument(run.stdout) as {
    error: { code: string; data: { errno: string } };
  };
  assert.equal(document.error.code, 'filesystem_write_failed');
  assert.equal(document.error.data.errno, 'ENOENT');
});

/**
 * A content response whose stream delivers `first` and then breaks. The error comes from a later
 * `pull()`, after a pause: erroring a stream drops chunks still queued or buffered, so an immediate
 * error would never really deliver the first chunk, and a real connection breaks some time after
 * its last bytes arrived.
 */
function breakingRuntime(first: Buffer) {
  const brokenBody = () => {
    let pulls = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new Uint8Array(first));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.error(new Error('socket hang up'));
        },
      }),
    );
  };
  return fakeRuntime(
    { 'workflows.getEvidence': () => evidenceRecord(first.byteLength * 2) },
    { 'workflows.getEvidenceContent': brokenBody },
  );
}

test('a broken evidence read exits 1, keeps only the bytes sent, and reports on stderr', async () => {
  const first = bytes.subarray(0, 4);

  const json = await runIsagi(['evidence', 'read', 'wev_1', '--run', '42', '--json'], {
    runtime: breakingRuntime(first),
  });
  assert.equal(json.code, 1);
  assert.deepEqual(json.stdoutBytes, first);
  const document = onlyJsonDocument(json.stderr) as { error: { code: string } };
  assert.equal(document.error.code, 'runtime_unreachable');

  const plain = await runIsagi(['evidence', 'read', 'wev_1', '--run', '42'], {
    runtime: breakingRuntime(first),
  });
  assert.equal(plain.code, 1);
  assert.deepEqual(plain.stdoutBytes, first);
  assert.match(plain.stderr, /^isagi: runtime_unreachable: .+\n$/);
});

test('a broken evidence export exits 1 with one error document and removes its file', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'isagi-cli-'));
  const run = await runIsagi(
    ['evidence', 'export', 'wev_1', '--run', '42', '--output', 'shot.png', '--json'],
    { runtime: breakingRuntime(bytes.subarray(0, 4)), cwd },
  );
  assert.equal(run.code, 1);
  const document = onlyJsonDocument(run.stdout) as { error: { code: string } };
  assert.equal(document.error.code, 'runtime_unreachable');
  assert.equal(run.stderr, '');
  assert.deepEqual(await readdir(cwd), []);
});

/** Three chunks, each from its own `pull()`, so a stdout failure can land part-way through. */
function chunkedRuntime() {
  const parts = [bytes.subarray(0, 3), bytes.subarray(3, 6), bytes.subarray(6)];
  return fakeRuntime(
    {},
    {
      'workflows.getEvidenceContent': () => {
        let index = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const part = parts[index++];
              if (part) controller.enqueue(new Uint8Array(part));
              else controller.close();
            },
          }),
        );
      },
    },
  );
}

function failingStdout(code: string) {
  let writes = 0;
  return new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      callback(writes > 1 ? Object.assign(new Error(code), { code }) : undefined);
    },
  });
}

test('an evidence read whose stdout fails part-way is a local write failure, not a runtime one', async () => {
  const run = await runIsagi(['evidence', 'read', 'wev_1', '--run', '42', '--json'], {
    runtime: chunkedRuntime(),
    stdout: failingStdout('EIO'),
  });
  assert.equal(run.code, 1);
  const document = onlyJsonDocument(run.stderr) as {
    error: { code: string; data: { errno: string } };
  };
  assert.equal(document.error.code, 'filesystem_write_failed');
  assert.equal(document.error.data.errno, 'EIO');
});

test('an evidence read whose reader stops early (EPIPE) is not a failure', async () => {
  const run = await runIsagi(['evidence', 'read', 'wev_1', '--run', '42'], {
    runtime: chunkedRuntime(),
    stdout: failingStdout('EPIPE'),
  });
  assert.equal(run.code, 0);
  assert.equal(run.stderr, '');
});
