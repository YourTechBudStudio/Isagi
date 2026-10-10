import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { runScoped } from '@isagi/testing';

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
      const failure = await runScoped(
        Effect.flip(
          EditorInstallIo.use((io) =>
            io.downloadTo({ url, destination: path.join(directory, 'artifact.tar.gz') }),
          ).pipe(Effect.provide(EditorInstallIo.layer)),
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
    const failure = await runScoped(
      Effect.flip(
        EditorInstallIo.use((io) =>
          io.extractTarGz({ archive, into: directory, stripComponents: 1 }),
        ).pipe(Effect.provide(EditorInstallIo.layer)),
      ),
    );
    assert.equal(failure.operation, 'extract');
    assert.equal(failure.status, null);
    // The wording is tar's and differs between bsdtar and GNU tar; that it is present and bounded is the contract.
    assert.ok(failure.output !== null && failure.output.length > 0);
    assert.ok(Buffer.byteLength(failure.output) <= 2_048);
  });
});
