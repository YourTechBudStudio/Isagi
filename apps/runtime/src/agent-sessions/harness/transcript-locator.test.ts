import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { transcriptAt } from './transcript-locator.js';

/**
 * The locator always answers, and the answer is about *now*.
 *
 * A native transcript is a best-effort external source (ADR 0007): the runtime neither writes it
 * nor owns its retention. So the only two useful shapes are "here is where it would be, and it is
 * there" and "here is where it would be, and it is not" — never a throw, and never a reference that
 * looks live because nobody checked.
 */
test('a transcript locator reports presence and absence without failing either way', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-transcript-locator-'));
  try {
    const present = join(root, 'session-1.jsonl');
    writeFileSync(present, '{}\n', 'utf8');

    assert.deepEqual(await Effect.runPromise(transcriptAt(present)), {
      locator: present,
      available: true,
    });

    // The constructed-but-never-written case, which is Claude's ordinary one: the path is derivable
    // from recorded facts whether or not the provider ever wrote a transcript there.
    const absent = join(root, 'session-never-written.jsonl');
    assert.deepEqual(await Effect.runPromise(transcriptAt(absent)), {
      locator: absent,
      available: false,
    });
    // The locator is echoed back unchanged in both cases, so a reader can follow it by hand even
    // when the runtime could not.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * An unreadable directory reads as unavailable, not as an error.
 *
 * From the reader's position "I cannot get at it" and "it is not there" call for the same next
 * step, and a locator that threw would turn a best-effort diagnostic into a failed read on a route
 * whose job is to answer.
 */
test('a transcript behind an unreadable directory reads as unavailable rather than throwing', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root bypasses directory permissions, so the denial cannot be staged');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'isagi-transcript-locator-'));
  const locked = join(root, 'locked');
  try {
    const hidden = join(locked, 'session-2.jsonl');
    mkdirSync(locked);
    writeFileSync(hidden, '{}\n', 'utf8');
    chmodSync(locked, 0o000);

    assert.deepEqual(await Effect.runPromise(transcriptAt(hidden)), {
      locator: hidden,
      available: false,
    });
  } finally {
    chmodSync(locked, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
