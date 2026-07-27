export interface TerminalViewportRowSignature {
  readonly text: string;
  readonly wrapped: boolean;
}

export type TerminalViewportMemory =
  | {
      readonly buffer: 'normal';
      readonly followLatest: boolean;
      readonly viewportY: number;
      readonly baseY: number;
      readonly columns: number;
      readonly rows: readonly TerminalViewportRowSignature[];
    }
  | {
      readonly buffer: 'alternate';
      readonly followLatest: true;
      readonly columns: number;
    };

export function normalizeViewportMemory(memory: TerminalViewportMemory): TerminalViewportMemory {
  if (memory.buffer === 'alternate') {
    return Object.freeze({ ...memory });
  }
  return Object.freeze({
    ...memory,
    rows: Object.freeze(memory.rows.slice(0, 3).map((row) => Object.freeze({ ...row }))),
  });
}
