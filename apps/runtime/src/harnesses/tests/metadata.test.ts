import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeHarnessMetadata } from '../ledger.js';

// Plan R29: the `harness.json` schema accepts exactly what the hand-written parser it replaced
// accepted, and words each rejection the same way (the diagnostic becomes the session's status
// reason). Every expectation below was produced by running that parser on the same text.
const object = 'Invalid harness metadata: Metadata must be an object.';
const version = 'Invalid harness metadata: Unsupported metadata schema version.';
const sessionId = 'Invalid harness metadata: Invalid harnessSessionId.';
const updatedAt = 'Invalid harness metadata: Invalid updatedAt.';

const rejections: readonly (readonly [raw: string, diagnostic: string])[] = [
  ['null', object],
  ['0', object],
  ['false', object],
  ['"metadata"', object],
  ['[]', version],
  ['[{"schemaVersion":1}]', version],
  ['{}', version],
  ['{"schemaVersion":"1","harnessSessionId":null,"updatedAt":"t"}', version],
  ['{"schemaVersion":2,"harnessSessionId":null,"updatedAt":"t"}', version],
  ['{"harnessSessionId":null,"updatedAt":"t"}', version],
  ['{"schemaVersion":1,"updatedAt":"t"}', sessionId],
  ['{"schemaVersion":1,"harnessSessionId":"","updatedAt":"t"}', sessionId],
  ['{"schemaVersion":1,"harnessSessionId":7,"updatedAt":"t"}', sessionId],
  ['{"schemaVersion":1,"harnessSessionId":false,"updatedAt":"t"}', sessionId],
  ['{"schemaVersion":1,"harnessSessionId":null}', updatedAt],
  ['{"schemaVersion":1,"harnessSessionId":null,"updatedAt":""}', updatedAt],
  ['{"schemaVersion":1,"harnessSessionId":null,"updatedAt":5}', updatedAt],
  ['{"schemaVersion":1,"harnessSessionId":null,"updatedAt":null}', updatedAt],
  // The first problem in key order wins, as it did in the old parser.
  ['{"schemaVersion":2,"harnessSessionId":"","updatedAt":""}', version],
  ['{"schemaVersion":1,"harnessSessionId":"","updatedAt":""}', sessionId],
];

test('harness metadata accepts a null or non-empty session id and drops unknown keys', () => {
  assert.deepEqual(
    decodeHarnessMetadata(
      '{"schemaVersion":1,"harnessSessionId":null,"updatedAt":"2026-07-09T00:00:00.000Z"}',
    ),
    {
      status: 'valid',
      metadata: { schemaVersion: 1, harnessSessionId: null, updatedAt: '2026-07-09T00:00:00.000Z' },
    },
  );
  assert.deepEqual(
    decodeHarnessMetadata(
      '{"schemaVersion":1,"harnessSessionId":"pi-session-1","updatedAt":"2026-07-09T00:00:00.000Z","extra":true}',
    ),
    {
      status: 'valid',
      metadata: {
        schemaVersion: 1,
        harnessSessionId: 'pi-session-1',
        updatedAt: '2026-07-09T00:00:00.000Z',
      },
    },
  );
});

test('harness metadata rejects what the old parser rejected, with the same diagnostic', () => {
  for (const [raw, diagnostic] of rejections) {
    assert.deepEqual(decodeHarnessMetadata(raw), { status: 'invalid', diagnostic }, raw);
  }
});

test('harness metadata that is not JSON carries the parser message', () => {
  let message = '';
  try {
    JSON.parse('{ nope');
  } catch (error) {
    message = (error as Error).message;
  }
  assert.deepEqual(decodeHarnessMetadata('{ nope'), {
    status: 'invalid',
    diagnostic: `Invalid harness metadata: ${message}`,
  });
});
