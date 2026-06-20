import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ptyCopy } from '../../copy/index.js';
import type {
  PtyStreamSink,
  PtyStreamSurfaceTransport,
} from '../../lib/workspace/pty-stream/index.js';
import { calculateTerminalFit } from './ptyFit.js';

type XtermRenderDimensions = {
  readonly css?: {
    readonly cell?: {
      readonly width?: number;
      readonly height?: number;
    };
  };
};

type XtermPrivateTerminal = Terminal & {
  readonly ['_core']?: {
    readonly ['_renderService']?: {
      readonly dimensions?: XtermRenderDimensions;
      readonly clear?: () => void;
    };
  };
};

type TerminalFitResult = 'fit' | 'unready';

export type XtermSurfaceKeyHandler = (
  event: KeyboardEvent,
  helpers: { readonly sendInput: (data: string) => void },
) => boolean;

const TERMINAL_FIT_RETRY_FRAMES = 12;

export function XtermSurface({
  transport,
  initiallyInteractive,
  disableScrollback = false,
  className = 'isagi-xterm isagi-xterm-edge min-h-0 flex-1',
  onInput,
  onFit,
  onReadyChange,
  onFocusHandleChange,
  onInteractiveChange,
  onRendererWarning,
  onCustomKey,
}: {
  readonly transport: PtyStreamSurfaceTransport;
  readonly initiallyInteractive: boolean;
  readonly disableScrollback?: boolean | undefined;
  readonly className?: string | undefined;
  readonly onInput?: ((data: string) => void) | undefined;
  readonly onFit?: ((cols: number, rows: number) => void) | undefined;
  readonly onReadyChange?: ((ready: boolean) => void) | undefined;
  readonly onFocusHandleChange?: ((focus: (() => void) | null) => void) | undefined;
  readonly onInteractiveChange?: ((interactive: boolean) => void) | undefined;
  readonly onRendererWarning: (message: string | null) => void;
  readonly onCustomKey?: XtermSurfaceKeyHandler | undefined;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [ready, setReady] = useState(false);

  const setSurfaceReady = useCallback(
    (next: boolean) => {
      setReady(next);
      onReadyChange?.(next);
    },
    [onReadyChange],
  );

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    let teardown: (() => void) | undefined;

    const fontsReady = Promise.all([
      document.fonts.ready,
      document.fonts.load('12px "Fira Code Variable"'),
      document.fonts.load('12px "Symbols Nerd Font Mono"'),
    ]).catch(() => undefined);
    void fontsReady.then(() => {
      if (disposed || !host) {
        return;
      }
      teardown = startXtermSurface(host);
    });

    return () => {
      disposed = true;
      teardown?.();
    };

    function startXtermSurface(container: HTMLElement) {
      let resizeObserver: ResizeObserver | null = null;
      let pendingResizeFrame: number | null = null;
      let warnedFitUnavailable = false;
      const terminalFontFamily = terminalFontFamilyFromElement(container);
      const terminal = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        disableStdin: !initiallyInteractive || !onInput,
        fontFamily: terminalFontFamily,
        fontSize: 12,
        lineHeight: 1.35,
        macOptionClickForcesSelection: true,
        rightClickSelectsWord: true,
        ...(disableScrollback ? { scrollback: 0 } : {}),
        theme: terminalThemeFromTokens(),
      });
      terminal.open(container);
      terminalRef.current = terminal;
      onFocusHandleChange?.(() => terminal.focus());

      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          onRendererWarning(ptyCopy.renderer.webglFallback);
        });
        terminal.loadAddon(webgl);
        onRendererWarning(null);
      } catch {
        onRendererWarning(ptyCopy.renderer.webglUnavailable);
      }

      const sendInput = (data: string) => {
        if (!onInput) {
          return;
        }
        terminal.scrollToBottom();
        onInput(data);
      };

      const fit = () => {
        try {
          if (disposed) {
            return 'unready' as const;
          }
          const result = fitTerminalToHost(terminal, container);
          if (result === 'fit') {
            onFit?.(terminal.cols, terminal.rows);
          }
          return result;
        } catch {
          return 'unready' as const;
        }
      };

      const scheduleFit = (attempt = 0) => {
        if (pendingResizeFrame !== null) {
          window.cancelAnimationFrame(pendingResizeFrame);
        }
        pendingResizeFrame = window.requestAnimationFrame(() => {
          pendingResizeFrame = null;
          if (fit() === 'fit' || disposed) {
            return;
          }
          const hostRect = container.getBoundingClientRect();
          const hostVisible = hostRect.width > 0 && hostRect.height > 0;
          if (hostVisible && attempt < TERMINAL_FIT_RETRY_FRAMES) {
            scheduleFit(attempt + 1);
            return;
          }
          if (hostVisible && !warnedFitUnavailable) {
            warnedFitUnavailable = true;
            console.warn('xterm fit skipped because render cell dimensions were unavailable.', {
              hostWidth: hostRect.width,
              hostHeight: hostRect.height,
            });
          }
        });
      };

      resizeObserver = new ResizeObserver(() => scheduleFit());
      resizeObserver.observe(container);
      scheduleFit();

      const inputDisposable = terminal.onData(sendInput);

      const handleTerminalKeyDown = (event: KeyboardEvent) => {
        if (isCopyShortcut(event)) {
          const selection = terminal.getSelection();
          if (selection) {
            event.preventDefault();
            event.stopPropagation();
            void navigator.clipboard?.writeText(selection).catch(() => {
              // The copy event handler covers the normal browser path; this is a best-effort fallback.
            });
            return;
          }
        }
        if (onCustomKey?.(event, { sendInput })) {
          return;
        }
      };
      container.addEventListener('keydown', handleTerminalKeyDown, true);

      const handleTerminalCopy = (event: ClipboardEvent) => {
        const selection = terminal.getSelection();
        if (!selection) {
          return;
        }
        event.clipboardData?.setData('text/plain', selection);
        event.preventDefault();
      };
      container.addEventListener('copy', handleTerminalCopy);

      const sink: PtyStreamSink = {
        write: (data) => terminal.write(data),
        setInteractive: (interactive) => {
          terminal.options.disableStdin = !interactive || !onInput;
          onInteractiveChange?.(interactive);
        },
        onConnected: () => scheduleFit(),
      };
      const disconnect = transport.connect(sink);
      setSurfaceReady(true);

      return () => {
        disposed = true;
        setSurfaceReady(false);
        disconnect();
        if (pendingResizeFrame !== null) {
          window.cancelAnimationFrame(pendingResizeFrame);
        }
        resizeObserver?.disconnect();
        inputDisposable.dispose();
        container.removeEventListener('keydown', handleTerminalKeyDown, true);
        container.removeEventListener('copy', handleTerminalCopy);
        terminalRef.current = null;
        onFocusHandleChange?.(null);
        terminal.dispose();
      };
    }
  }, [
    transport,
    initiallyInteractive,
    disableScrollback,
    onInput,
    onFit,
    onRendererWarning,
    onFocusHandleChange,
    onInteractiveChange,
    onCustomKey,
    setSurfaceReady,
  ]);

  return <div ref={containerRef} className={className} data-ready={ready ? 'true' : 'false'} />;
}

function isCopyShortcut(event: KeyboardEvent) {
  if (event.type !== 'keydown' || event.key.toLowerCase() !== 'c') {
    return false;
  }
  if (isMacPlatform()) {
    return event.metaKey && !event.altKey;
  }
  return event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
}

function isMacPlatform() {
  return /mac/i.test(navigator.platform);
}

function fitTerminalToHost(terminal: Terminal, host: HTMLElement): TerminalFitResult {
  const xtermElement = terminal.element;
  const renderService = (terminal as XtermPrivateTerminal)['_core']?.['_renderService'];
  const cell = renderService?.dimensions?.css?.cell;
  if (!xtermElement || !cell?.width || !cell.height) {
    return 'unready';
  }

  const xtermStyle = window.getComputedStyle(xtermElement);
  const hostRect = host.getBoundingClientRect();
  const size = calculateTerminalFit({
    hostWidth: hostRect.width,
    hostHeight: hostRect.height,
    paddingLeft: cssPixelValue(xtermStyle.paddingLeft),
    paddingRight: cssPixelValue(xtermStyle.paddingRight),
    paddingTop: cssPixelValue(xtermStyle.paddingTop),
    paddingBottom: cssPixelValue(xtermStyle.paddingBottom),
    cellWidth: cell.width,
    cellHeight: cell.height,
  });
  if (!size) {
    return 'unready';
  }

  if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
    renderService?.clear?.();
    terminal.resize(size.cols, size.rows);
  }
  return 'fit';
}

function cssPixelValue(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function terminalFontFamilyFromElement(element: HTMLElement) {
  const fontFamily = window.getComputedStyle(element).fontFamily.trim();
  return fontFamily || 'monospace';
}

function terminalThemeFromTokens() {
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
