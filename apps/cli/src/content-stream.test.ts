import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import { Effect } from 'effect';

import { ContentStreamFailure, streamContent } from './content-stream.js';

const chunks = [Buffer.from('one '), Buffer.from('two '), Buffer.from('three')];

/** A body that delivers each chunk from its own `pull()`, then breaks if asked to, after a pause. */
function body(options: { readonly breakAfter?: number } = {}) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options.breakAfter !== undefined && index === options.breakAfter) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.error(new Error('socket hang up'));
        return;
      }
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(new Uint8Array(chunk));
      else controller.close();
    },
  });
}

/** A destination that accepts `accept` writes, then fails the next one like a full disk. */
function destination(accept = Number.POSITIVE_INFINITY) {
  const received: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (received.length >= accept) {
        callback(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
        return;
      }
      received.push(chunk);
      callback();
    },
  });
  return { stream, received };
}

test('a complete stream reports the bytes written', async () => {
  const target = destination();
  const written = await Effect.runPromise(streamContent(body(), target.stream, { end: true }));
  assert.equal(written, 13);
  assert.equal(Buffer.concat(target.received).toString(), 'one two three');
});

test('a write that fails part-way is the destination, even though the download is torn down too', async () => {
  const target = destination(1);
  const failure = await Effect.runPromise(
    Effect.flip(streamContent(body(), target.stream, { end: true })),
  );
  assert.ok(failure instanceof ContentStreamFailure);
  assert.equal(failure.side, 'destination');
  assert.equal((failure.cause as { code?: string }).code, 'ENOSPC');
});

test('a download that breaks part-way is the source, even though the write is torn down too', async () => {
  const target = destination();
  const failure = await Effect.runPromise(
    Effect.flip(streamContent(body({ breakAfter: 1 }), target.stream, { end: true })),
  );
  assert.equal(failure.side, 'source');
  assert.equal(Buffer.concat(target.received).toString(), 'one ');
});

test('an absent body writes nothing', async () => {
  const target = destination();
  const written = await Effect.runPromise(streamContent(null, target.stream, { end: true }));
  assert.equal(written, 0);
  assert.equal(target.received.length, 0);
});
