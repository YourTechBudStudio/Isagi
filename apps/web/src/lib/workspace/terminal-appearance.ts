import type { ITerminalInitOnlyOptions, ITerminalOptions, ITheme } from '@xterm/xterm';

/**
 * The single source of truth for how an xterm instance looks in Isagi.
 *
 * Every terminal — cache-owned hot presentations and the disposable command-log
 * surface alike — builds its options here, so typography, palette, and font
 * readiness cannot drift between the two renderers. xterm draws to a canvas and
 * cannot inherit CSS, so the design tokens have to be read out of the document
 * and handed to it explicitly; `--font-terminal` and the color tokens in
 * `styles.css` stay authoritative and this module only transcribes them.
 */

export const TERMINAL_FONT_SIZE = 12;
export const TERMINAL_LINE_HEIGHT = 1.35;

/**
 * The classes that make a DOM node a terminal surface: the terminal font stack,
 * the terminal background, and clipped edges. A cached host carries these itself
 * so it stays correctly dressed while it is parked or in flight between slots.
 */
export const TERMINAL_HOST_CLASS = 'isagi-xterm isagi-xterm-edge';

/**
 * Resolve before constructing a terminal. xterm measures its cell box once from
 * the configured family; measuring against a fallback face and then having the
 * real one load leaves every glyph mis-boxed.
 */
export function loadTerminalFonts(): Promise<void> {
  // One shared promise: font readiness is a document-wide fact, and every
  // terminal construction waits on it, including the cold ones that arrive one
  // after another as a workspace fills in.
  pendingTerminalFonts ??= requestTerminalFonts();
  return pendingTerminalFonts;
}

let pendingTerminalFonts: Promise<void> | null = null;

function requestTerminalFonts(): Promise<void> {
  return Promise.all([
    document.fonts.ready,
    document.fonts.load(`${TERMINAL_FONT_SIZE}px "Fira Code Variable"`),
    document.fonts.load(`${TERMINAL_FONT_SIZE}px "Symbols Nerd Font Mono"`),
  ]).then(
    () => undefined,
    () => undefined,
  );
}

export function terminalInitOptions(options: {
  readonly disableStdin: boolean;
  readonly scrollback?: number | undefined;
}): ITerminalOptions & ITerminalInitOnlyOptions {
  return {
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    disableStdin: options.disableStdin,
    fontFamily: terminalFontFamily(),
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: true,
    ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback }),
    theme: terminalThemeFromTokens(),
  };
}

/**
 * The `--font-terminal` stack: the mono face first, then whatever Nerd/symbols
 * font is installed. Read from the token rather than from a host element's
 * computed style, so a terminal built before its host is dressed — or parked
 * outside the styled tree entirely — still gets the real stack.
 */
export function terminalFontFamily(): string {
  const styles = window.getComputedStyle(document.documentElement);
  return styles.getPropertyValue('--font-terminal').trim() || 'monospace';
}

export function terminalThemeFromTokens(): ITheme {
  const styles = window.getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  const canvas = token('--color-canvas');
  const elevated = token('--color-elevated');
  const terminalSurface = token('--color-terminal-surface') || blendHex(elevated, canvas, 0.5);
  const fg = token('--color-fg');
  const fgSubtle = token('--color-fg-subtle');
  const line = token('--color-line');
  const blue = token('--color-blue');
  const violet = token('--color-violet');
  const amber = token('--color-amber');
  const green = token('--color-green');
  const red = token('--color-red');
  const cyan = token('--color-cyan');

  return {
    background: terminalSurface,
    foreground: fg,
    cursor: cyan,
    selectionBackground: alphaHex(fgSubtle, '66'),
    scrollbarSliderBackground: alphaHex(line, '57'),
    scrollbarSliderHoverBackground: alphaHex(line, '8f'),
    scrollbarSliderActiveBackground: alphaHex(line, 'a8'),
    black: terminalSurface,
    red,
    green,
    yellow: amber,
    blue,
    magenta: violet,
    cyan,
    white: fg,
    brightBlack: fgSubtle,
    brightRed: red,
    brightGreen: green,
    brightYellow: amber,
    brightBlue: blue,
    brightMagenta: violet,
    brightCyan: cyan,
    brightWhite: fg,
  };
}

function blendHex(foreground: string, background: string, opacity: number) {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (!fg || !bg) {
    return background;
  }

  const mix = (fgChannel: number, bgChannel: number) =>
    Math.round(fgChannel * opacity + bgChannel * (1 - opacity));

  return rgbToHex(mix(fg.r, bg.r), mix(fg.g, bg.g), mix(fg.b, bg.b));
}

function parseHexColor(color: string) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  const [, r, g, b] = match ?? [];
  if (!r || !g || !b) {
    return null;
  }

  return {
    r: Number.parseInt(r, 16),
    g: Number.parseInt(g, 16),
    b: Number.parseInt(b, 16),
  };
}

function rgbToHex(r: number, g: number, b: number) {
  const channel = (value: number) => value.toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function alphaHex(color: string, alpha: string) {
  return /^#[\da-f]{6}$/i.test(color) ? `${color}${alpha}` : color;
}
