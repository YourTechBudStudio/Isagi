export interface TerminalFitMeasurement {
  readonly hostWidth: number;
  readonly hostHeight: number;
  readonly paddingLeft: number;
  readonly paddingRight: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
}

export interface TerminalFitSize {
  readonly cols: number;
  readonly rows: number;
}

const MINIMUM_TERMINAL_COLS = 2;
const MINIMUM_TERMINAL_ROWS = 1;

export function calculateTerminalFit(measurement: TerminalFitMeasurement): TerminalFitSize | null {
  if (
    !isPositiveFinite(measurement.hostWidth) ||
    !isPositiveFinite(measurement.hostHeight) ||
    !isPositiveFinite(measurement.cellWidth) ||
    !isPositiveFinite(measurement.cellHeight)
  ) {
    return null;
  }

  const availableWidth = Math.max(
    0,
    measurement.hostWidth - measurement.paddingLeft - measurement.paddingRight,
  );
  const availableHeight = Math.max(
    0,
    measurement.hostHeight - measurement.paddingTop - measurement.paddingBottom,
  );

  return {
    cols: Math.max(MINIMUM_TERMINAL_COLS, Math.floor(availableWidth / measurement.cellWidth)),
    rows: Math.max(MINIMUM_TERMINAL_ROWS, Math.floor(availableHeight / measurement.cellHeight)),
  };
}

function isPositiveFinite(value: number) {
  return Number.isFinite(value) && value > 0;
}
