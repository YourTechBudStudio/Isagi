import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test, { mock } from 'node:test';

import { Effect } from 'effect';

import { DatabaseError } from '../../persistence/index.js';
import { makeWorkflowContentStore } from './content-store.js';
import { contentPathFor, makeWorkflowPersistenceFixture, run } from './test-support.js';

/**
 * The byte store underneath every recorded value and every captured piece of evidence.
 *
 * Three properties are worth a test of their own, and none of them are visible from the JSON layer
 * above: bytes reach disk while their source is still producing, a reference is verified before its
 * bytes are ever served, and the catalog row is only written once the bytes are durable.
 */

const chunkBytes = 4 * 1024 * 1024;

function refOf(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

test('a streamed publication reaches disk while its source is still producing', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const chunk = Buffer.alloc(chunkBytes, 'a');
    const chunks = 5;
    const totalBytes = chunkBytes * chunks;
    const incoming = join(fixture.contentRoot, 'incoming');

    // Probed at the moment the source is asked for its fourth chunk. A store that buffered the
    // whole value before writing has either no staging directory at all or an empty file there, and
    // both of those must fail this test rather than read as a size of zero — which is why the probe
    // records its own error instead of defaulting.
    let stagedBytes: number | null = null;
    let probeFailure: unknown = null;
    let pushed = 0;

    const source = new Readable({
      read() {
        if (pushed === 3 && stagedBytes === null && probeFailure === null) {
          try {
            const staged = readdirSync(incoming);
            if (staged.length !== 1) {
              throw new Error(`expected exactly one staged file, found ${staged.length}`);
            }
            stagedBytes = statSync(join(incoming, staged[0]!)).size;
          } catch (cause) {
            probeFailure = cause;
          }
        }
        if (pushed >= chunks) {
          this.push(null);
          return;
        }
        pushed += 1;
        this.push(chunk);
      },
    });

    const published = await run(fixture.content.put({ source, mediaTypeHint: 'image/png' }));

    assert.equal(probeFailure, null, `staging probe failed: ${String(probeFailure)}`);
    assert.ok(stagedBytes !== null, 'the staging probe never ran');
    assert.ok(stagedBytes! > 0, 'no bytes had reached disk before the source finished');
    assert.ok(
      stagedBytes! < totalBytes,
      'the whole value was on disk before the source finished, so it was buffered',
    );

    assert.equal(published.byteSize, totalBytes);
    assert.equal(published.contentRef, refOf(Buffer.alloc(totalBytes, 'a')));
    assert.equal(
      statSync(contentPathFor(fixture.contentRoot, published.contentRef)).size,
      totalBytes,
    );
    assert.deepEqual(readdirSync(incoming), [], 'the staged file is renamed away, not left behind');
  } finally {
    fixture.close();
  }
});

test('two identical streams publish one file and one catalog row', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const bytes = Buffer.alloc(chunkBytes, 'b');
    const first = await run(
      fixture.content.put({ source: Readable.from([bytes]), mediaTypeHint: 'text/plain' }),
    );
    const second = await run(
      fixture.content.put({ source: Readable.from([bytes]), mediaTypeHint: 'text/markdown' }),
    );

    assert.equal(second.contentRef, first.contentRef, 'content identity, not publication identity');
    assert.equal(second.byteSize, first.byteSize);

    const path = contentPathFor(fixture.contentRoot, first.contentRef);
    const shard = readdirSync(join(fixture.contentRoot, first.contentRef.slice(7, 9)));
    assert.equal(shard.length, 1, 'the second publication reuses the file rather than adding one');
    assert.equal(statSync(path).size, bytes.byteLength);
    assert.deepEqual(readdirSync(join(fixture.contentRoot, 'incoming')), []);

    const rows = fixture.client
      .prepare('SELECT count(*) AS count FROM workflow_payloads')
      .get() as { count: number };
    assert.equal(rows.count, 1);

    // The catalog keeps the first publisher's hint and no read path consults it, which is exactly
    // why the same digest can serve two different media types without either one lying.
    const row = fixture.client
      .prepare('SELECT media_type AS mediaType FROM workflow_payloads')
      .get() as { mediaType: string };
    assert.equal(row.mediaType, 'text/plain');
  } finally {
    fixture.close();
  }
});

test('an unreadable reference is reported as missing or corrupt, never as a value', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const bytes = Buffer.from('the bytes a reference names');
    const { contentRef } = await run(
      fixture.content.put({ source: bytes, mediaTypeHint: 'text/plain' }),
    );
    const path = contentPathFor(fixture.contentRoot, contentRef);

    const served = await run(fixture.content.readAll(contentRef));
    assert.deepEqual(served, bytes);

    // Truncated: the prefix is genuine, so only hashing the whole file catches it.
    writeFileSync(path, bytes.subarray(0, 10));
    assert.equal(await causeOfOpen(fixture.content.open(contentRef)), 'corrupt');

    // Edited in place: same length, different bytes.
    const edited = Buffer.from(bytes);
    edited[0] = edited[0]! ^ 0xff;
    writeFileSync(path, edited);
    assert.equal(await causeOfOpen(fixture.content.open(contentRef)), 'corrupt');
    assert.equal(await causeOfOpen(fixture.content.readAll(contentRef)), 'corrupt');

    const absent = `sha256:${'0'.repeat(64)}`;
    assert.equal(await causeOfOpen(fixture.content.open(absent)), 'missing');
    assert.equal(await causeOfOpen(fixture.content.readAll(absent)), 'missing');

    // A syntactically invalid reference never reaches the filesystem, and is still an honest
    // "nothing is there" rather than a thrown defect. Asserted on both readers: they verify
    // differently on purpose, so neither one's mapping is covered by the other.
    for (const malformed of ['not-a-reference', `sha256:${'z'.repeat(64)}`]) {
      assert.equal(await causeOfOpen(fixture.content.open(malformed)), 'missing');
      assert.equal(await causeOfOpen(fixture.content.readAll(malformed)), 'missing');
    }
  } finally {
    fixture.close();
  }
});

test('a publication that cannot be committed leaves no catalog row', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  const bytes = Buffer.alloc(16_384, 'c');
  const ref = refOf(bytes);
  // The shard folder exists and refuses new entries, so staging and hashing both succeed and the
  // rename is what fails — the last step before the row would be written.
  const shard = join(fixture.contentRoot, ref.slice(7, 9));
  try {
    mkdirSync(shard, { recursive: true });
    chmodSync(shard, 0o500);

    const result = await Effect.runPromise(
      Effect.either(fixture.content.put({ source: bytes, mediaTypeHint: 'text/plain' })),
    );
    assert.equal(result._tag, 'Left', 'publication must fail rather than return a reference');

    const rows = fixture.client
      .prepare('SELECT count(*) AS count FROM workflow_payloads')
      .get() as { count: number };
    assert.equal(rows.count, 0, 'a row must never describe bytes that are not there');
    assert.equal(existsSync(contentPathFor(fixture.contentRoot, ref)), false);
    assert.deepEqual(
      readdirSync(join(fixture.contentRoot, 'incoming')),
      [],
      'a handled failure removes its own staged file',
    );
  } finally {
    // Restored here, not after the assertions: a failing assertion above would otherwise leave a
    // non-writable directory behind and turn one clear failure into a cleanup cascade. Tolerant,
    // because the directory may not exist if the very first statement is what failed.
    try {
      chmodSync(shard, 0o700);
    } catch {
      // Nothing to restore.
    }
    fixture.close();
  }
});

test('the fixture can fail exactly one publication', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    fixture.failNextPut();
    const failed = await Effect.runPromise(
      Effect.either(fixture.content.put({ source: Buffer.from('x'), mediaTypeHint: 'text/plain' })),
    );
    assert.equal(failed._tag, 'Left');
    assert.equal(failed._tag === 'Left' ? failed.left._tag : null, 'ContentPublishError');

    const recovered = await run(
      fixture.content.put({ source: Buffer.from('x'), mediaTypeHint: 'text/plain' }),
    );
    assert.equal(recovered.contentRef, refOf(Buffer.from('x')), 'only the next put is affected');
  } finally {
    fixture.close();
  }
});

test('a catalog write that fails after the bytes are durable names the orphaned reference', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    const store = makeWorkflowContentStore(fixture.contentRoot, {
      ...fixture.database,
      use: (operation) =>
        Effect.fail(new DatabaseError({ operation, cause: 'injected catalog failure' })),
    });
    const bytes = Buffer.from('durable but uncatalogued');
    const failed = await Effect.runPromise(
      Effect.either(store.put({ source: bytes, mediaTypeHint: 'text/plain' })),
    );
    assert.equal(failed._tag === 'Left' ? failed.left._tag : null, 'DatabaseError');
    assert.ok(existsSync(contentPathFor(fixture.contentRoot, refOf(bytes))), 'bytes stay on disk');
    assert.equal(warn.mock.callCount(), 1);
    const detail = warn.mock.calls[0]!.arguments[1] as Record<string, unknown>;
    assert.equal(detail.contentRef, refOf(bytes));
  } finally {
    warn.mock.restore();
    fixture.close();
  }
});

async function causeOfOpen(effect: Effect.Effect<unknown, { readonly cause: string }>) {
  const result = await Effect.runPromise(Effect.either(effect));
  return result._tag === 'Left' ? result.left.cause : null;
}
