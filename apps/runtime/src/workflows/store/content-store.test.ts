import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { Effect } from 'effect';

import { contentPathFor, makeWorkflowContentStore } from './content-store.js';

function withStore(body: (dataRoot: string, contentRoot: string) => Promise<void>) {
  return async () => {
    const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-content-store-')));
    try {
      await body(dataRoot, join(dataRoot, 'workflow-content'));
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  };
}

const sha = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test(
  'publishing the same bytes twice yields one verified file',
  withStore(async (dataRoot, contentRoot) => {
    const { service } = makeWorkflowContentStore(dataRoot);
    const bytes = Buffer.from('hello, checkpoint');
    const [first, second] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const capture = yield* service.openCapture;
          const published = yield* capture.put({ source: Readable.from([bytes]) });
          const republished = yield* capture.put({ source: Readable.from([bytes]) });
          return [published, republished] as const;
        }),
      ),
    );
    assert.equal(first.contentRef, sha(bytes));
    assert.equal(second.contentRef, first.contentRef);
    assert.equal(first.byteSize, bytes.byteLength);
    const read = await Effect.runPromise(service.readAll(first.contentRef));
    assert.deepEqual(read, bytes);
    assert.deepEqual(readdirSync(join(contentRoot, 'incoming')), [], 'no temp file is left behind');
  }),
);

test(
  'an unreadable reference is reported as missing or corrupt, never as a value',
  withStore(async (dataRoot, contentRoot) => {
    const { service } = makeWorkflowContentStore(dataRoot);
    const bytes = Buffer.from('original');
    const { contentRef } = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(service.openCapture, (capture) =>
          capture.put({ source: Readable.from([bytes]) }),
        ),
      ),
    );

    writeFileSync(contentPathFor(contentRoot, contentRef), 'edited');
    const corrupt = await Effect.runPromise(Effect.flip(service.readAll(contentRef)));
    assert.equal(corrupt.cause, 'corrupt');

    const missing = await Effect.runPromise(Effect.flip(service.open(sha(Buffer.from('never')))));
    assert.equal(missing.cause, 'missing');

    const malformed = await Effect.runPromise(Effect.flip(service.readAll('not-a-ref')));
    assert.equal(malformed.cause, 'missing');
  }),
);
