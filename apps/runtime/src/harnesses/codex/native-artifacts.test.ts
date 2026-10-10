import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { locateCodexRolloutPaths, readCodexConversationEntries } from './native-artifacts.js';

test('Codex index-only lookup does not recursively scan native session storage', async () => {
  const codexDirectory = mkdtempSync(join(tmpdir(), 'isagi-codex-locator-'));
  try {
    const harnessSessionId = 'codex-session-redacted';
    const directory = join(codexDirectory, 'sessions', '2026', '07', '09');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `rollout-test-${harnessSessionId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: harnessSessionId },
      })}\n`,
    );
    const indexOnly = await Effect.runPromise(
      locateCodexRolloutPaths({
        agentSessionId: 10,
        harnessSessionId,
        codexDirectory,
        discovery: 'index_only',
      }),
    );
    const full = await Effect.runPromise(
      locateCodexRolloutPaths({
        agentSessionId: 10,
        harnessSessionId,
        codexDirectory,
        discovery: 'full',
      }),
    );
    assert.deepEqual(indexOnly, []);
    assert.deepEqual(full, [{ harnessSessionId, path }]);
  } finally {
    rmSync(codexDirectory, { recursive: true, force: true });
  }
});

test('Codex conversation reading follows nested byte-bounded history without importing parent tails', async () => {
  const codexDirectory = mkdtempSync(join(tmpdir(), 'isagi-codex-history-'));
  try {
    const grandparentId = 'codex-grandparent-redacted';
    const parentId = 'codex-parent-redacted';
    const childId = 'codex-child-redacted';

    const grandparentPrefix = transcript([
      sessionMeta(grandparentId, 0),
      event(1, 'grandparent prompt with multibyte text: こんにちは 👋'),
    ]);
    writeRollout(
      codexDirectory,
      grandparentId,
      `${grandparentPrefix}${transcript([event(2, 'unrelated grandparent tail')])}`,
    );

    const parentPrefix = transcript([
      sessionMeta(parentId, 2, {
        threadId: grandparentId,
        endOrdinalExclusive: 2,
        endByteOffset: Buffer.byteLength(grandparentPrefix),
      }),
      event(3, 'parent answer'),
    ]);
    writeRollout(
      codexDirectory,
      parentId,
      `${parentPrefix}${transcript([event(4, 'unrelated parent tail')])}`,
    );

    const childPath = writeRollout(
      codexDirectory,
      childId,
      transcript([
        sessionMeta(childId, 4, {
          threadId: parentId,
          endOrdinalExclusive: 4,
          endByteOffset: Buffer.byteLength(parentPrefix),
        }),
        event(5, 'child prompt'),
      ]),
    );

    const result = await Effect.runPromise(
      readCodexConversationEntries({
        agentSessionId: 11,
        paths: [{ harnessSessionId: childId, path: childPath }],
        codexDirectory,
        missingIsExpected: false,
      }),
    );

    assert.equal(result.foundReadable, true);
    assert.deepEqual(
      result.entries.map((entry) => entry.ordinal),
      [0, 1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      result.entries.flatMap((entry) => {
        const payload = record(entry.payload);
        return typeof payload.label === 'string' ? [payload.label] : [];
      }),
      ['grandparent prompt with multibyte text: こんにちは 👋', 'parent answer', 'child prompt'],
    );
  } finally {
    rmSync(codexDirectory, { recursive: true, force: true });
  }
});

test('Codex conversation reading degrades to the child page for missing, unrelated, or cyclic ancestry', async () => {
  const codexDirectory = mkdtempSync(join(tmpdir(), 'isagi-codex-history-degraded-'));
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const unrelatedBaseId = 'codex-unrelated-base-redacted';
    writeRollout(
      codexDirectory,
      unrelatedBaseId,
      transcript([sessionMeta('different-session-redacted', 0), event(1, 'unrelated')]),
    );
    const childId = 'codex-degraded-child-redacted';
    const childPath = writeRollout(
      codexDirectory,
      childId,
      transcript([
        sessionMeta(childId, 2, {
          threadId: unrelatedBaseId,
          endOrdinalExclusive: 2,
          endByteOffset: 10,
        }),
        event(3, 'kept child page'),
      ]),
    );
    const cyclicId = 'codex-cycle-redacted';
    const cyclicPath = writeRollout(
      codexDirectory,
      cyclicId,
      transcript([
        sessionMeta(cyclicId, 0, {
          threadId: cyclicId,
          endOrdinalExclusive: 0,
          endByteOffset: 1,
        }),
        event(1, 'kept cyclic page'),
      ]),
    );

    const degraded = await Effect.runPromise(
      readCodexConversationEntries({
        agentSessionId: 12,
        paths: [{ harnessSessionId: childId, path: childPath }],
        codexDirectory,
        missingIsExpected: false,
      }),
    );
    const cyclic = await Effect.runPromise(
      readCodexConversationEntries({
        agentSessionId: 12,
        paths: [{ harnessSessionId: cyclicId, path: cyclicPath }],
        codexDirectory,
        missingIsExpected: false,
      }),
    );

    assert.deepEqual(
      degraded.entries.map((entry) => entry.ordinal),
      [2, 3],
    );
    assert.deepEqual(
      cyclic.entries.map((entry) => entry.ordinal),
      [0, 1],
    );
    assert.deepEqual(
      warnings.flatMap((warning) => {
        const details = record(warning[1]);
        return typeof details.code === 'string' ? [details.code] : [];
      }),
      ['history_base_unavailable', 'history_cycle'],
    );
  } finally {
    console.warn = originalWarn;
    rmSync(codexDirectory, { recursive: true, force: true });
  }
});

interface HistoryBase {
  readonly threadId: string;
  readonly endOrdinalExclusive: number;
  readonly endByteOffset: number;
}

function sessionMeta(sessionId: string, ordinal: number, historyBase?: HistoryBase) {
  return {
    ordinal,
    type: 'session_meta',
    payload: {
      session_id: sessionId,
      id: sessionId,
      history_mode: 'paginated',
      ...(historyBase
        ? {
            history_base: {
              thread_id: historyBase.threadId,
              end_ordinal_exclusive: historyBase.endOrdinalExclusive,
              end_byte_offset: historyBase.endByteOffset,
            },
          }
        : {}),
    },
  };
}

function event(ordinal: number, label: string) {
  return { ordinal, type: 'event_msg', payload: { type: 'fixture', label } };
}

function transcript(entries: readonly Record<string, unknown>[]) {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function writeRollout(codexDirectory: string, sessionId: string, contents: string) {
  const directory = join(codexDirectory, 'sessions', '2026', '08', '26');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `rollout-test-${sessionId}.jsonl`);
  writeFileSync(path, contents, 'utf8');
  return path;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
