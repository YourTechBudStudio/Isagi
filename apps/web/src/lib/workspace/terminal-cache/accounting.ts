/**
 * Parsed-buffer cost is estimated as a fixed per-entry allowance plus a per-cell cost across the
 * retained normal and alternate buffers. The estimator is a single injectable port so production
 * evidence can recalibrate it in one place instead of at every attachment site.
 */
export interface TerminalBufferMeasurement {
  readonly normalCells: number;
  readonly alternateCells: number;
}

export type TerminalAccountingEstimator = (measurement: TerminalBufferMeasurement) => number;

export const terminalEntryAllowanceBytes = 1024 * 1024;
export const terminalCellCostBytes = 48;

export const emptyTerminalBufferMeasurement: TerminalBufferMeasurement = Object.freeze({
  normalCells: 0,
  alternateCells: 0,
});

export const estimateTerminalPresentationBytes: TerminalAccountingEstimator = (measurement) => {
  const normalCells = requireCellCount(measurement.normalCells, 'normalCells');
  const alternateCells = requireCellCount(measurement.alternateCells, 'alternateCells');
  return terminalEntryAllowanceBytes + terminalCellCostBytes * (normalCells + alternateCells);
};

export function normalizeEstimatedBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Estimated terminal presentation bytes must be a non-negative integer.');
  }
  return value;
}

function requireCellCount(value: number, field: keyof TerminalBufferMeasurement): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Terminal buffer measurement ${field} must be a non-negative integer.`);
  }
  return value;
}
