import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeCaptureInput, type NormalizeCaptureResult } from './input.js';

const good = {
  title: 'Reviewer feedback',
  role: 'review-feedback',
  content: { kind: 'text' as const, text: 'looks fine' },
};

const refusal = (result: NormalizeCaptureResult) => {
  assert.equal(result.ok, false, 'expected the call to be refused');
  return result.ok ? assert.fail('unreachable') : result;
};

const accepted = (result: NormalizeCaptureResult) => {
  if (!result.ok) assert.fail(`expected acceptance, got ${result.reason}`);
  return result.value;
};

describe('evidence input normalisation', () => {
  it('accepts the ordinary call and puts no bytes in the identity', () => {
    const value = accepted(normalizeCaptureInput(good));
    assert.deepEqual(value.request, {
      capability: 'capture_evidence',
      title: 'Reviewer feedback',
      role: 'review-feedback',
      labels: null,
      contentKind: 'text',
      mediaType: 'text/plain',
      sourcePath: null,
      source: null,
    });
    // The whole recovery story turns on this: the fingerprinted request must not carry the content.
    assert.equal(JSON.stringify(value.request).includes('looks fine'), false);
    assert.deepEqual(value.body, { kind: 'buffer', bytes: Buffer.from('looks fine', 'utf8') });
  });

  it('trims the title but refuses an empty or oversized one rather than truncating', () => {
    assert.equal(
      accepted(normalizeCaptureInput({ ...good, title: '  spaced  ' })).request.title,
      'spaced',
    );
    assert.equal(refusal(normalizeCaptureInput({ ...good, title: '   ' })).reason, 'invalid_title');
    assert.equal(refusal(normalizeCaptureInput({ ...good, title: 42 })).reason, 'invalid_title');
    const long = 'x'.repeat(513);
    const rejected = refusal(normalizeCaptureInput({ ...good, title: long }));
    assert.equal(rejected.reason, 'invalid_title');
    assert.deepEqual(rejected.detail, { length: 513, limit: 512 });
    // 512 exactly is the limit, not one short of it.
    assert.equal(
      accepted(normalizeCaptureInput({ ...good, title: 'x'.repeat(512) })).request.title.length,
      512,
    );
  });

  it('holds the role to the workflow-identifier grammar', () => {
    for (const role of ['plan', 'review-feedback', 'a.b_c-9', '0']) {
      assert.equal(accepted(normalizeCaptureInput({ ...good, role })).request.role, role);
    }
    for (const role of ['', 'Plan', '-leading', 'has space', 'has:colon', 'x'.repeat(65)]) {
      assert.equal(
        refusal(normalizeCaptureInput({ ...good, role })).reason,
        'invalid_role',
        `expected ${JSON.stringify(role)} to be refused`,
      );
    }
  });

  it('accepts scalar labels and refuses everything a filter could not index', () => {
    const labels = { phase: 2, round: 'two', final: false };
    assert.deepEqual(accepted(normalizeCaptureInput({ ...good, labels })).request.labels, labels);
    assert.equal(
      accepted(normalizeCaptureInput({ ...good, labels: undefined })).request.labels,
      null,
    );
    // camelCase stays legal; it is the colon the list filter splits on that does not.
    assert.deepEqual(
      accepted(normalizeCaptureInput({ ...good, labels: { reviewRound: 2 } })).request.labels,
      { reviewRound: 2 },
    );

    const cases: readonly [string, unknown][] = [
      ['nested object', { nested: { a: 1 } }],
      ['null value', { key: null }],
      ['array value', { key: [1] }],
      ['non-finite number', { key: Number.POSITIVE_INFINITY }],
      ['colon in key', { 'a:b': 1 }],
      ['control character in key', { 'a\u0001b': 1 }],
      ['empty key', { '': 1 }],
      ['oversized key', { ['k'.repeat(65)]: 1 }],
      ['oversized value', { key: 'v'.repeat(1025) }],
      ['too many entries', Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]))],
      ['array instead of object', [1, 2]],
    ];
    for (const [name, value] of cases) {
      assert.equal(
        refusal(normalizeCaptureInput({ ...good, labels: value })).reason,
        'invalid_labels',
        `expected ${name} to be refused`,
      );
    }
    // Exactly at the limits, both accepted — the boundary is enforced, not approximated.
    assert.ok(normalizeCaptureInput({ ...good, labels: { key: 'v'.repeat(1024) } }).ok);
    assert.ok(
      normalizeCaptureInput({
        ...good,
        labels: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, i])),
      }).ok,
    );
  });

  it('projects a source to its identity-bearing fields and drops the rest', () => {
    // The natural authoring shape: hand back the AgentSessionHandle `spawnAgentSession` returned.
    // Its `paneId` is environment-lifetime data and must not reach a durable call identity.
    const handle = { agentSessionId: 7, sentAt: '2026-01-01T00:00:00.000Z', paneId: 99 };
    const request = accepted(
      normalizeCaptureInput({ ...good, source: { kind: 'agent_turn', target: handle } }),
    ).request;
    assert.deepEqual(request.source, {
      kind: 'agent_turn',
      agentSessionId: 7,
      sentAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(
      JSON.stringify(request).includes('99'),
      false,
      'paneId must not reach the identity',
    );

    assert.deepEqual(
      accepted(
        normalizeCaptureInput({
          ...good,
          source: { kind: 'headless_operation', operation: { operationId: 'wop_1' } },
        }),
      ).request.source,
      { kind: 'headless_operation', operationId: 'wop_1' },
    );
    assert.deepEqual(
      accepted(
        normalizeCaptureInput({ ...good, source: { kind: 'agent_session', agentSessionId: 3 } }),
      ).request.source,
      { kind: 'agent_session', agentSessionId: 3 },
    );
  });

  it('refuses a malformed source', () => {
    const cases: readonly [string, unknown][] = [
      ['unknown kind', { kind: 'telepathy' }],
      ['missing target', { kind: 'agent_turn' }],
      [
        'non-integer session id',
        { kind: 'agent_turn', target: { agentSessionId: 1.5, sentAt: 'x' } },
      ],
      ['empty sentAt', { kind: 'agent_turn', target: { agentSessionId: 1, sentAt: '' } }],
      ['missing operation', { kind: 'headless_operation' }],
      ['empty operation id', { kind: 'headless_operation', operation: { operationId: '' } }],
      ['non-integer agent session', { kind: 'agent_session', agentSessionId: '3' }],
      ['not an object', 'agent_turn'],
    ];
    for (const [name, source] of cases) {
      assert.equal(
        refusal(normalizeCaptureInput({ ...good, source })).reason,
        'invalid_source',
        `expected ${name} to be refused`,
      );
    }
  });

  it('normalises each content kind to the right media type and body', () => {
    const text = accepted(normalizeCaptureInput(good));
    assert.equal(text.request.mediaType, 'text/plain');
    assert.equal(
      accepted(
        normalizeCaptureInput({
          ...good,
          content: { kind: 'text', text: '# h', mediaType: 'text/markdown' },
        }),
      ).request.mediaType,
      'text/markdown',
    );

    const json = accepted(
      normalizeCaptureInput({ ...good, content: { kind: 'json', value: { b: 1, a: 2 } } }),
    );
    assert.equal(json.request.mediaType, 'application/json');
    assert.equal(json.body.kind, 'buffer');
    // Canonical, so two authors building the same object in different key orders publish one blob.
    assert.equal(
      json.body.kind === 'buffer' ? json.body.bytes.toString('utf8') : null,
      '{"a":2,"b":1}',
    );

    const bytes = accepted(
      normalizeCaptureInput({
        ...good,
        content: { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
      }),
    );
    assert.equal(bytes.request.mediaType, 'image/png');
    assert.deepEqual(bytes.body.kind === 'buffer' ? [...bytes.body.bytes] : null, [1, 2, 3]);

    const file = accepted(
      normalizeCaptureInput({ ...good, content: { kind: 'file', path: 'docs/plan.md' } }),
    );
    assert.equal(file.request.mediaType, 'text/markdown');
    assert.equal(file.request.sourcePath, 'docs/plan.md');
    assert.deepEqual(file.body, { kind: 'file', relativePath: 'docs/plan.md' });
    assert.equal(
      accepted(normalizeCaptureInput({ ...good, content: { kind: 'file', path: 'out/blob' } }))
        .request.mediaType,
      'application/octet-stream',
    );
  });

  it('refuses a value JSON cannot canonicalise, and a media type it cannot parse', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(
      refusal(normalizeCaptureInput({ ...good, content: { kind: 'json', value: cyclic } })).reason,
      'unserializable_json',
    );
    assert.equal(
      refusal(
        normalizeCaptureInput({ ...good, content: { kind: 'text', text: 'x', mediaType: 'nope' } }),
      ).reason,
      'invalid_media_type',
    );
    // `bytes` has no filename to guess from, so its media type is required rather than defaulted.
    assert.equal(
      refusal(
        normalizeCaptureInput({ ...good, content: { kind: 'bytes', bytes: new Uint8Array() } }),
      ).reason,
      'invalid_media_type',
    );
  });

  it('separates "your content is unusable" from "your media type is unparseable"', () => {
    // `invalid_media_type` used to answer for all of these, sending an author who forgot `content`
    // to a field they never set.
    const contentCases: readonly [string, unknown][] = [
      ['unknown kind', { kind: 'telepathy' }],
      ['text that is not a string', { kind: 'text', text: 42 }],
      ['bytes that are not a view', { kind: 'bytes', bytes: [1, 2], mediaType: 'image/png' }],
      ['a path that is not a string', { kind: 'file', path: undefined }],
    ];
    for (const [name, content] of contentCases) {
      assert.equal(
        refusal(normalizeCaptureInput({ ...good, content })).reason,
        'invalid_content',
        `expected ${name} to report invalid_content`,
      );
    }
    assert.equal(
      refusal(normalizeCaptureInput({ ...good, content: undefined })).reason,
      'invalid_content',
    );
    assert.equal(refusal(normalizeCaptureInput(null)).reason, 'invalid_content');
  });

  it('treats no labels and empty labels as the same call identity', () => {
    // Both store as `{}`, so distinguishing them in the fingerprint would refuse an author who
    // tidied `labels: {}` out of the call as `operation_request_changed` on the next Retry.
    assert.equal(accepted(normalizeCaptureInput({ ...good, labels: {} })).request.labels, null);
    assert.deepEqual(
      accepted(normalizeCaptureInput({ ...good, labels: {} })).request,
      accepted(normalizeCaptureInput(good)).request,
    );
  });

  it('copies captured bytes rather than aliasing the caller array', () => {
    const source = new Uint8Array([1, 2, 3]);
    const value = accepted(
      normalizeCaptureInput({
        ...good,
        content: { kind: 'bytes', bytes: source, mediaType: 'image/png' },
      }),
    );
    // Publication happens later in the effect. "Keep this exact thing" has to mean the thing as it
    // was at the call, not whatever the caller's buffer holds by the time the bytes are written.
    source[0] = 99;
    assert.deepEqual(value.body.kind === 'buffer' ? [...value.body.bytes] : null, [1, 2, 3]);

    // A Buffer is a Uint8Array subclass and is the ordinary thing a Node author has in hand.
    const fromBuffer = accepted(
      normalizeCaptureInput({
        ...good,
        content: { kind: 'bytes', bytes: Buffer.from([7, 8]), mediaType: 'image/png' },
      }),
    );
    assert.deepEqual(fromBuffer.body.kind === 'buffer' ? [...fromBuffer.body.bytes] : null, [7, 8]);
  });

  it('refuses a view that is not a Uint8Array rather than capturing the wrong bytes', () => {
    // The guard has to accept exactly what the copy can carry. `Buffer.from` reads any other view
    // as an array-like of numbers: a 16-byte Float64Array would land as 2 truncated bytes and a
    // DataView as nothing at all — silently, and durably, with a byte_size agreeing with the wrong
    // content. Refusing is the only honest answer for a record that can never be corrected.
    for (const [name, bytes] of [
      ['Float64Array', new Float64Array([1.5, 2.5])],
      ['DataView', new DataView(new ArrayBuffer(4))],
      ['Int16Array', new Int16Array([256, 512])],
    ] as const) {
      const rejected = refusal(
        normalizeCaptureInput({
          ...good,
          content: { kind: 'bytes', bytes, mediaType: 'image/png' },
        }),
      );
      assert.equal(rejected.reason, 'invalid_content', `expected ${name} to be refused`);
      assert.equal(rejected.detail.expected, 'a Uint8Array');
    }
  });

  it('refuses a file path that escapes the worktree, syntactically', () => {
    for (const path of ['../x', '/abs/x', 'C:\\x', 'a/../../x', '', '.', 'a\0b']) {
      assert.equal(
        refusal(normalizeCaptureInput({ ...good, content: { kind: 'file', path } })).reason,
        'path_outside_worktree',
        `expected ${JSON.stringify(path)} to be refused`,
      );
    }
    // A `..` that stays inside is fine, and the recorded path is the normalised form.
    assert.equal(
      accepted(normalizeCaptureInput({ ...good, content: { kind: 'file', path: 'a/../b.md' } }))
        .request.sourcePath,
      'b.md',
    );
    assert.equal(
      accepted(normalizeCaptureInput({ ...good, content: { kind: 'file', path: 'a\\b.md' } }))
        .request.sourcePath,
      'a/b.md',
    );
  });

  it('checks title, then role, then labels, then source, then content', () => {
    // All five wrong at once: the complaint is stable, so an author fixing one at a time meets the
    // same order on every run rather than a different reason each pass.
    const result = refusal(
      normalizeCaptureInput({
        title: '',
        role: 'BAD',
        labels: { nested: {} },
        source: { kind: 'telepathy' },
        content: { kind: 'text', text: 'x', mediaType: 'nope' },
      }),
    );
    assert.equal(result.reason, 'invalid_title');
  });
});
