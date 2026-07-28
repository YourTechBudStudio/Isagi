import type { IBuffer } from '@xterm/xterm';

import type { TerminalViewportMemory } from '../terminal-cache/index.js';

export type TerminalViewportCause = 'user' | 'restore' | 'resize' | 'output';

export interface TerminalViewportCausality {
  readonly begin: (cause: Exclude<TerminalViewportCause, 'user'>) => symbol;
  readonly end: (token: symbol) => void;
  readonly current: () => TerminalViewportCause;
}

export function createTerminalViewportCausality(): TerminalViewportCausality {
  const active = new Map<symbol, Exclude<TerminalViewportCause, 'user'>>();
  return {
    begin(cause) {
      const token = Symbol(`terminal-viewport-${cause}`);
      active.set(token, cause);
      return token;
    },
    end(token) {
      active.delete(token);
    },
    current() {
      // Restoration is most specific, followed by geometry and output. This is
      // deterministic even when asynchronous write and resize scopes overlap.
      const causes = new Set(active.values());
      if (causes.has('restore')) return 'restore';
      if (causes.has('resize')) return 'resize';
      if (causes.has('output')) return 'output';
      return 'user';
    },
  };
}

export function captureTerminalViewport(input: {
  readonly buffer: IBuffer;
  readonly columns: number;
  readonly cause: TerminalViewportCause;
  readonly previous: TerminalViewportMemory | null;
}): TerminalViewportMemory {
  const { buffer, columns } = input;
  if (buffer.type === 'alternate') {
    return { buffer: 'alternate', followLatest: true, columns };
  }

  const observedFollowLatest = buffer.viewportY === buffer.baseY;
  const followLatest =
    input.cause === 'user' || input.previous?.buffer !== 'normal'
      ? observedFollowLatest
      : input.previous.followLatest;
  const rows = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const line = buffer.getLine(buffer.viewportY + offset);
    if (!line) return normalMemory(buffer, columns, followLatest, []);
    rows.push({ text: line.translateToString(true), wrapped: line.isWrapped });
  }
  return normalMemory(buffer, columns, followLatest, rows);
}

export type TerminalViewportRestoration =
  | { readonly type: 'none'; readonly reason: 'alternate' | 'incompatible' }
  | { readonly type: 'bottom' }
  | {
      readonly type: 'row';
      readonly row: number;
      readonly source: 'signature' | 'saved' | 'oldest';
    };

export function selectTerminalViewportRestoration(input: {
  readonly memory: TerminalViewportMemory | null;
  readonly activeBuffer: IBuffer;
  readonly columns: number;
}): TerminalViewportRestoration {
  const { memory, activeBuffer, columns } = input;
  if (!memory) return { type: 'row', row: 0, source: 'oldest' };
  if (memory.buffer === 'alternate' || activeBuffer.type === 'alternate') {
    return {
      type: 'none',
      reason: memory.buffer === activeBuffer.type ? 'alternate' : 'incompatible',
    };
  }
  if (memory.followLatest) return { type: 'bottom' };

  const savedRow = clamp(memory.viewportY, 0, activeBuffer.baseY);
  if (memory.rows.length === 3) {
    const matches: number[] = [];
    for (let row = 0; row <= activeBuffer.length - 3; row += 1) {
      if (signatureMatches(activeBuffer, row, memory.rows)) matches.push(row);
    }
    if (matches.length > 0) {
      matches.sort((left, right) => {
        const distance = Math.abs(left - savedRow) - Math.abs(right - savedRow);
        return distance === 0 ? left - right : distance;
      });
      return { type: 'row', row: matches[0]!, source: 'signature' };
    }
  }
  if (memory.columns === columns) return { type: 'row', row: savedRow, source: 'saved' };
  return { type: 'row', row: 0, source: 'oldest' };
}

function normalMemory(
  buffer: IBuffer,
  columns: number,
  followLatest: boolean,
  rows: readonly { readonly text: string; readonly wrapped: boolean }[],
): TerminalViewportMemory {
  return {
    buffer: 'normal',
    followLatest,
    viewportY: buffer.viewportY,
    baseY: buffer.baseY,
    columns,
    rows,
  };
}

function signatureMatches(
  buffer: IBuffer,
  start: number,
  signature: readonly { readonly text: string; readonly wrapped: boolean }[],
) {
  return signature.every((expected, offset) => {
    const line = buffer.getLine(start + offset);
    return (
      line !== undefined &&
      line.isWrapped === expected.wrapped &&
      line.translateToString(true) === expected.text
    );
  });
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
