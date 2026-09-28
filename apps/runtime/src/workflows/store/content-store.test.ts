import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { Effect } from 'effect';

import { contentPathFor, makeWorkflowContentStore } from './content-store.js';

function withStore(body: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'isagi-content-store-'));
    try {
      await body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const sha = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test(
  'a buffer and a stream of the same bytes publish one verified file',
  withStore(async (root) => {
    const store = makeWorkflowContentStore(root);
    const bytes = Buffer.from('hello, checkpoint');
    const fromBuffer = await Effect.runPromise(store.put({ source: bytes }));
    const fromStream = await Effect.runPromise(store.put({ source: Readable.from([bytes]) }));
    assert.equal(fromBuffer.contentRef, sha(bytes));
    assert.equal(fromStream.contentRef, fromBuffer.contentRef);
    assert.equal(fromBuffer.byteSize, bytes.byteLength);
    const read = await Effect.runPromise(store.readAll(fromBuffer.contentRef));
    assert.deepEqual(read, bytes);
    assert.deepEqual(readdirSync(join(root, 'incoming')), [], 'no temp file is left behind');
  }),
);

test(
  'an unreadable reference is reported as missing or corrupt, never as a value',
  withStore(async (root) => {
    const store = makeWorkflowContentStore(root);
    const bytes = Buffer.from('original');
    const { contentRef } = await Effect.runPromise(store.put({ source: bytes }));

    writeFileSync(contentPathFor(root, contentRef), 'edited');
    const corrupt = await Effect.runPromise(Effect.flip(store.readAll(contentRef)));
    assert.equal(corrupt.cause, 'corrupt');

    const missing = await Effect.runPromise(Effect.flip(store.open(sha(Buffer.from('never')))));
    assert.equal(missing.cause, 'missing');

    const malformed = await Effect.runPromise(Effect.flip(store.readAll('not-a-ref')));
    assert.equal(malformed.cause, 'missing');
  }),
);
