import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IBuffer, IBufferLine } from '@xterm/xterm';

import type { TerminalViewportMemory } from '../terminal-cache/index.js';
import {
  captureTerminalViewport,
  createTerminalViewportCausality,
  selectTerminalViewportRestoration,
} from './viewport.js';

describe('terminal viewport capture', () => {
  it('captures three stable public-buffer rows and preserves scroll intent across trim', () => {
    const previous = memory({ followLatest: false, viewportY: 4 });
    const captured = captureTerminalViewport({
      buffer: buffer(['new top', 'reading', 'here'], { viewportY: 0, baseY: 6 }),
      columns: 80,
      cause: 'output',
      previous,
    });
    assert.equal(captured.buffer, 'normal');
    if (captured.buffer !== 'normal') throw new Error('Expected normal memory.');
    assert.equal(captured.followLatest, false);
    assert.deepEqual(captured.rows, [
      { text: 'new top', wrapped: false },
      { text: 'reading', wrapped: false },
      { text: 'here', wrapped: false },
    ]);
  });

  it('does not manufacture a partial signature after ED3 or trimming', () => {
    const captured = captureTerminalViewport({
      buffer: buffer(['only', 'two'], { viewportY: 0, baseY: 0 }),
      columns: 80,
      cause: 'output',
      previous: memory({ followLatest: false }),
    });
    assert.equal(captured.buffer, 'normal');
    if (captured.buffer === 'normal') assert.deepEqual(captured.rows, []);
  });

  it('records alternate-buffer observation without normal anchors', () => {
    assert.deepEqual(
      captureTerminalViewport({
        buffer: buffer(['tui'], { type: 'alternate' }),
        columns: 120,
        cause: 'user',
        previous: null,
      }),
      { buffer: 'alternate', followLatest: true, columns: 120 },
    );
  });

  it('uses tokenized causal precedence for overlapping writes, resize, and restore', () => {
    const causes = createTerminalViewportCausality();
    const output = causes.begin('output');
    const resize = causes.begin('resize');
    assert.equal(causes.current(), 'resize');
    const restore = causes.begin('restore');
    assert.equal(causes.current(), 'restore');
    causes.end(restore);
    assert.equal(causes.current(), 'resize');
    causes.end(resize);
    assert.equal(causes.current(), 'output');
    causes.end(output);
    assert.equal(causes.current(), 'user');
  });
});

describe('terminal viewport restoration', () => {
  it('chooses the nearest duplicate signature and the older row on a tie', () => {
    const active = buffer(['a', 'b', 'c', 'x', 'a', 'b', 'c'], { baseY: 6 });
    assert.deepEqual(
      selectTerminalViewportRestoration({
        memory: memory({ viewportY: 2, rows: signature('a', 'b', 'c') }),
        activeBuffer: active,
        columns: 80,
      }),
      { type: 'row', row: 0, source: 'signature' },
    );
  });

  it('uses saved-row fallback only at matching columns and oldest after reflow', () => {
    const active = buffer(['different'], { baseY: 8, length: 9 });
    const saved = memory({ viewportY: 20, rows: signature('gone', 'rows', 'now') });
    assert.deepEqual(
      selectTerminalViewportRestoration({ memory: saved, activeBuffer: active, columns: 80 }),
      { type: 'row', row: 8, source: 'saved' },
    );
    assert.deepEqual(
      selectTerminalViewportRestoration({ memory: saved, activeBuffer: active, columns: 81 }),
      { type: 'row', row: 0, source: 'oldest' },
    );
  });

  it('returns to bottom for followers and never scrolls incompatible buffers', () => {
    const normal = buffer(['normal']);
    const alternate = buffer(['tui'], { type: 'alternate' });
    assert.deepEqual(
      selectTerminalViewportRestoration({
        memory: memory({ followLatest: true }),
        activeBuffer: normal,
        columns: 80,
      }),
      { type: 'bottom' },
    );
    assert.deepEqual(
      selectTerminalViewportRestoration({
        memory: memory({}),
        activeBuffer: alternate,
        columns: 80,
      }),
      { type: 'none', reason: 'incompatible' },
    );
  });
});

function memory(
  overrides: Partial<Extract<TerminalViewportMemory, { buffer: 'normal' }>>,
): Extract<TerminalViewportMemory, { buffer: 'normal' }> {
  return {
    buffer: 'normal',
    followLatest: false,
    viewportY: 0,
    baseY: 10,
    columns: 80,
    rows: signature('one', 'two', 'three'),
    ...overrides,
  };
}

function signature(...texts: string[]) {
  return texts.map((text) => ({ text, wrapped: false }));
}

function buffer(
  texts: readonly string[],
  options: {
    readonly type?: 'normal' | 'alternate';
    readonly viewportY?: number;
    readonly baseY?: number;
    readonly length?: number;
  } = {},
): IBuffer {
  const lines = texts.map((text) => line(text));
  return {
    type: options.type ?? 'normal',
    cursorX: 0,
    cursorY: 0,
    viewportY: options.viewportY ?? 0,
    baseY: options.baseY ?? 0,
    length: options.length ?? lines.length,
    getLine: (row) => lines[row],
    getNullCell: () => ({}) as never,
  };
}

function line(text: string): IBufferLine {
  return {
    isWrapped: false,
    length: text.length,
    getCell: () => undefined,
    translateToString: () => text,
  };
}
