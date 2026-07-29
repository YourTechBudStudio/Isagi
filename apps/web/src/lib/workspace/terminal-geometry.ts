import type { Terminal } from '@xterm/xterm';

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

type XtermPrivateTerminal = Terminal & {
  readonly ['_core']?: {
    readonly ['_renderService']?: {
      readonly dimensions?: {
        readonly css?: { readonly cell?: { readonly width?: number; readonly height?: number } };
      };
      readonly clear?: () => void;
    };
  };
};

/**
 * The rendered cell box is only available on xterm's private render service, so
 * both the cached and the disposable renderer read it through here rather than
 * reaching into `_core` in two places. Returns `null` while the terminal has not
 * measured a cell yet or the host has no layout — the caller retries.
 */
export function measureTerminalFit(terminal: Terminal, host: HTMLElement): TerminalFitSize | null {
  const element = terminal.element;
  const cell = renderServiceOf(terminal)?.dimensions?.css?.cell;
  if (!element || !cell?.width || !cell.height) {
    return null;
  }

  const style = window.getComputedStyle(element);
  return calculateTerminalFit({
    // xterm is sized for the host's settled layout box. A Motion layout projection
    // temporarily transforms that box while surrounding chrome enters or leaves;
    // getBoundingClientRect() includes the projection and can therefore preserve
    // stale terminal geometry after the transform ends without another resize event.
    hostWidth: host.clientWidth,
    hostHeight: host.clientHeight,
    paddingLeft: cssPixelValue(style.paddingLeft),
    paddingRight: cssPixelValue(style.paddingRight),
    paddingTop: cssPixelValue(style.paddingTop),
    paddingBottom: cssPixelValue(style.paddingBottom),
    cellWidth: cell.width,
    cellHeight: cell.height,
  });
}

/** Drop cached glyph rows before a resize so the next frame repaints cleanly. */
export function clearTerminalRenderCache(terminal: Terminal): void {
  renderServiceOf(terminal)?.clear?.();
}

function renderServiceOf(terminal: Terminal) {
  return (terminal as XtermPrivateTerminal)['_core']?.['_renderService'];
}

function cssPixelValue(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isPositiveFinite(value: number) {
  return Number.isFinite(value) && value > 0;
}
