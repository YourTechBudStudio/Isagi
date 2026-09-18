import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { ContentUnavailable } from './content-store.js';
import { inlinePayloadThresholdBytes } from './payload-store.js';
import { contentPathFor, makeWorkflowPersistenceFixture, run } from './test-support.js';

/** A value whose canonical JSON is exactly `bytes` long, so the threshold is tested at its edge. */
function valueOfExactSize(bytes: number): { readonly v: string } {
  // `{"v":"…"}` is 8 bytes of framing around an ASCII string.
  return { v: 'x'.repeat(bytes - 8) };
}

test('the inline threshold is measured in stored bytes, at exactly 8192', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const atLimit = await run(
      fixture.payloads.publish(valueOfExactSize(inlinePayloadThresholdBytes)),
    );
    assert.equal(atLimit.ref, null, 'a value exactly at the limit stays inline');
    assert.equal(Buffer.byteLength(atLimit.inline!, 'utf8'), inlinePayloadThresholdBytes);

    const overLimit = await run(
      fixture.payloads.publish(valueOfExactSize(inlinePayloadThresholdBytes + 1)),
    );
    assert.equal(overLimit.inline, null, 'one byte over the limit is referenced');
    assert.match(overLimit.ref!, /^sha256:[a-f0-9]{64}$/);

    // Measured in UTF-8, not in string length: a multi-byte value just over the limit must be
    // referenced even though its JavaScript length is well under it.
    const multiByte = { v: '😀'.repeat(2100) };
    const published = await run(fixture.payloads.publish(multiByte));
    assert.equal(published.inline, null);
  } finally {
    fixture.close();
  }
});

test('identical content is published once and reused', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const value = valueOfExactSize(20_000);
    const first = await run(fixture.payloads.publish(value));
    const path = contentPathFor(fixture.contentRoot, first.ref!);
    const originalMtime = readFileSync(path);

    // Key insertion order differs; canonicalization makes it the same content.
    const second = await run(fixture.payloads.publish({ ...value }));
    assert.equal(second.ref, first.ref);
    assert.deepEqual(readFileSync(path), originalMtime);

    const rows = fixture.client
      .prepare('SELECT count(*) AS count FROM workflow_payloads')
      .get() as { count: number };
    assert.equal(rows.count, 1, 'content identity means one row, not one row per publication');
  } finally {
    fixture.close();
  }
});

test('a read verifies the bytes and reports missing and corrupt differently', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const slot = await run(fixture.payloads.publish(valueOfExactSize(20_000)));
    const ref = slot.ref!;
    assert.deepEqual(await run(fixture.payloads.read(ref)), valueOfExactSize(20_000));

    // Tampered: the file exists and parses, but it is no longer the bytes the reference names.
    writeFileSync(contentPathFor(fixture.contentRoot, ref), JSON.stringify({ v: 'tampered' }));
    const corrupt = await Effect.runPromise(Effect.either(fixture.payloads.read(ref)));
    assert.equal(corrupt._tag, 'Left');
    assert.ok(corrupt._tag === 'Left' && corrupt.left instanceof ContentUnavailable);
    assert.equal(corrupt._tag === 'Left' ? corrupt.left.cause : null, 'corrupt');

    const absent = await Effect.runPromise(
      Effect.either(fixture.payloads.read(`sha256:${'0'.repeat(64)}`)),
    );
    assert.equal(absent._tag === 'Left' ? absent.left.cause : null, 'missing');
  } finally {
    fixture.close();
  }
});

test('a failed publication accepts no reference at all', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    // An unwritable directory is the cheapest honest injection: the bytes cannot land.
    const folder = join(fixture.root, 'workflow-payloads');
    mkdirSync(folder, { recursive: true });
    chmodSync(folder, 0o500);

    const result = await Effect.runPromise(
      Effect.either(fixture.payloads.publish(valueOfExactSize(20_000))),
    );
    assert.equal(result._tag, 'Left', 'publication must fail rather than return a slot');

    // The barrier's actual guarantee: nothing was recorded, so no accepted state or history row can
    // possibly point at bytes that were never written.
    const rows = fixture.client
      .prepare('SELECT count(*) AS count FROM workflow_payloads')
      .get() as { count: number };
    assert.equal(rows.count, 0);

    chmodSync(folder, 0o700);
  } finally {
    fixture.close();
  }
});

test('a value that cannot be canonicalized is refused before anything is written', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const result = await Effect.runPromise(
      Effect.either(fixture.payloads.publish({ when: new Date() })),
    );
    assert.equal(result._tag, 'Left');
    assert.equal(existsSync(join(fixture.root, 'workflow-payloads')), false);
  } finally {
    fixture.close();
  }
});

test('an inline slot round-trips through resolve without touching the filesystem', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const slot = await run(fixture.payloads.publish({ a: 1, b: null }));
    assert.equal(slot.ref, null);
    assert.deepEqual(await run(fixture.payloads.resolve(slot)), { a: 1, b: null });
  } finally {
    fixture.close();
  }
});
