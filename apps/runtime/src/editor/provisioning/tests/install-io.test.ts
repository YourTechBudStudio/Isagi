import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Effect, Tracer } from 'effect';

import { EditorDownloadFailed, EditorInstallIo, EditorInstallIoError } from '../install-io.js';

/**
 * The real IO seam, against a real `tar` and a real local HTTP server. The install tests drive a recording double;
 * these pin the two pieces of evidence the double stands in for: a release server's status and `tar`'s stderr.
 */

function withTemporaryDirectory<A>(use: (directory: string) => Promise<A>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'isagi-editor-install-io-'));
  return use(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test('a download the server refuses carries its status and the URL it asked for', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/code-server.tar.gz`;
  try {
    await withTemporaryDirectory(async (directory) => {
      const failure = await Effect.runPromise(
        Effect.scoped(
          Effect.flip(
            EditorInstallIo.use((io) =>
              io.downloadTo({ url, destination: path.join(directory, 'artifact.tar.gz') }),
            ).pipe(Effect.provide(EditorInstallIo.layer)),
          ),
        ),
      );
      assert.ok(failure instanceof EditorInstallIoError);
      assert.equal(failure.operation, 'download');
      assert.equal(failure.status, 404);
      assert.ok(failure.cause instanceof EditorDownloadFailed);
      assert.equal(failure.cause.url, url);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('extracting an archive tar cannot read fails with tar’s own bounded output', async () => {
  await withTemporaryDirectory(async (directory) => {
    const archive = path.join(directory, 'artifact.tar.gz');
    writeFileSync(archive, 'not a gzip stream');
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(
          EditorInstallIo.use((io) =>
            io.extractTarGz({ archive, into: directory, stripComponents: 1 }),
          ).pipe(Effect.provide(EditorInstallIo.layer)),
        ),
      ),
    );
    assert.equal(failure.operation, 'extract');
    assert.equal(failure.status, null);
    // The wording is tar's and differs between bsdtar and GNU tar; that it is present and bounded is the contract.
    assert.ok(failure.output !== null && failure.output.length > 0);
    assert.ok(Buffer.byteLength(failure.output) <= 2_048);
  });
});

test('every member runs under a span named for it', async () => {
  // A failure or defect inside a member is reported with the span frame that names the operation, so each member must
  // open one rather than only the ones written as generators.
  const spans: string[] = [];
  const recordingTracer = Tracer.make({
    span(options) {
      spans.push(options.name);
      return Tracer.nativeTracer.span(options);
    },
  });
  await withTemporaryDirectory(async (directory) => {
    const executable = path.join(directory, 'code-server');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);
    await Effect.runPromise(
      Effect.scoped(
        EditorInstallIo.use((io) =>
          Effect.gen(function* () {
            yield* io.assertExecutable(executable);
            yield* io.prepareEditorState({ editorsPath: path.join(directory, 'editors') });
          }),
        ).pipe(Effect.provide(EditorInstallIo.layer), Effect.withTracer(recordingTracer)),
      ),
    );
  });
  assert.deepEqual(
    spans.filter((name) => name.startsWith('EditorInstallIo.')),
    ['EditorInstallIo.assertExecutable', 'EditorInstallIo.prepareEditorState'],
  );
});
