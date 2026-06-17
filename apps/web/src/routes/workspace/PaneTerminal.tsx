import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ptyCopy } from '../../copy/index.js';
import type {
  PaneTerminalSink,
  PaneTransport,
} from '../../lib/workspace/pane-session/transport.js';
import type { PtyPaneSession } from '../../lib/workspace/pane-session/view.js';
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

const TERMINAL_FIT_RETRY_FRAMES = 12;

/**
 * A purely presentational xterm surface. It owns the terminal widget and its
 * input/clipboard/fit behavior, and exchanges bytes with the hook-owned
 * websocket through `transport`. It never claims, resolves urls, or opens a
 * socket — so remounting it (e.g. to start a fresh attach) can never re-claim a
 * session.
 */
export function PaneTerminal({
  session,
  focused,
  transport,
  onRendererWarning,
}: {
  readonly session: PtyPaneSession;
  readonly focused: boolean;
  readonly transport: PaneTransport;
  readonly onRendererWarning: (message: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const focusedRef = useRef(focused);
  const focusFrameRef = useRef<readonly number[]>([]);
  // The terminal is constructed asynchronously (after fonts load), so the focus
  // effect below cannot rely on it existing at mount; this flips once it does.
  const [terminalReady, setTerminalReady] = useState(false);
  const sessionId = session.id;
  const shimShiftEnter = session.kind === 'agent_session';
  const disableScrollback = session.kind === 'agent_session' && session.harness === 'opencode';
  const initiallyInteractive = session.status === 'running';

  useEffect(() => {
    focusedRef.current = focused;
  }, [focused]);

  const cancelScheduledFocus = useCallback(() => {
    for (const frame of focusFrameRef.current) {
      window.cancelAnimationFrame(frame);
    }
    focusFrameRef.current = [];
  }, []);

  const scheduleTerminalFocus = useCallback(() => {
    cancelScheduledFocus();
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      focusFrameRef.current = focusFrameRef.current.filter((frame) => frame !== firstFrame);
      secondFrame = window.requestAnimationFrame(() => {
        focusFrameRef.current = focusFrameRef.current.filter((frame) => frame !== secondFrame);
        terminalRef.current?.focus();
      });
      focusFrameRef.current = [...focusFrameRef.current, secondFrame];
    });
    focusFrameRef.current = [firstFrame];
  }, [cancelScheduledFocus]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    let teardown: (() => void) | undefined;

    // xterm measures cell geometry and bakes its glyph atlas at construction and
    // never re-checks. Fonts loaded after that leave misaligned glyphs and wrong
    // cell widths on both the WebGL and DOM renderers, so we construct only once
    // the terminal's fonts are usable. document.fonts.ready alone is not enough:
    // it only awaits faces already in the loading set, and the bundled icon
    // @font-face loads lazily (nothing has rendered a glyph that needs it yet), so
    // we explicitly kick off its load — otherwise users without a system Nerd Font
    // still get a corrupted first paint. document.fonts.load resolves immediately
    // for locally-installed families and is a no-op once cached, so in the steady
    // state this only defers the very first terminal of a session.
    const fontsReady = Promise.all([
      document.fonts.ready,
      document.fonts.load('12px "Fira Code Variable"'),
      document.fonts.load('12px "Symbols Nerd Font Mono"'),
    ]).catch(() => undefined);
    void fontsReady.then(() => {
      if (disposed || !host) {
        return;
      }
      teardown = startXtermSession(host);
    });

    return () => {
      // Set before teardown so an unmount that races font loading (terminal not
      // yet constructed, teardown still undefined) still cancels startXtermSession.
      disposed = true;
      teardown?.();
    };

    function startXtermSession(container: HTMLElement) {
      let resizeObserver: ResizeObserver | null = null;
      let pendingResizeFrame: number | null = null;
      let warnedFitUnavailable = false;
      const terminalFontFamily = terminalFontFamilyFromElement(container);
      const terminal = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        disableStdin: !initiallyInteractive,
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
        terminal.scrollToBottom();
        transport.sendInput(data);
      };

      const sendResize = () => {
        try {
          if (disposed) {
            return 'unready' as const;
          }
          const result = fitTerminalToHost(terminal, container);
          if (result === 'unready') {
            return result;
          }
          transport.sendResize(terminal.cols, terminal.rows);
          return result;
        } catch {
          // xterm can briefly report zero-size geometry while the canvas is animating.
          return 'unready' as const;
        }
      };

      const scheduleResize = (attempt = 0) => {
        if (pendingResizeFrame !== null) {
          window.cancelAnimationFrame(pendingResizeFrame);
        }
        pendingResizeFrame = window.requestAnimationFrame(() => {
          pendingResizeFrame = null;
          if (sendResize() === 'fit' || disposed) {
            return;
          }
          const hostRect = container.getBoundingClientRect();
          const hostVisible = hostRect.width > 0 && hostRect.height > 0;
          if (hostVisible && attempt < TERMINAL_FIT_RETRY_FRAMES) {
            scheduleResize(attempt + 1);
            return;
          }
          if (hostVisible && !warnedFitUnavailable) {
            warnedFitUnavailable = true;
            console.warn('xterm fit skipped because render cell dimensions were unavailable.', {
              ptySessionId: sessionId,
              hostWidth: hostRect.width,
              hostHeight: hostRect.height,
            });
          }
        });
      };

      resizeObserver = new ResizeObserver(() => scheduleResize());
      resizeObserver.observe(container);
      scheduleResize();

      const inputDisposable = terminal.onData(sendInput);

      let lastHandledShiftEnterAt = 0;
      const handleShiftEnter = (event: KeyboardEvent) => {
        if (
          !shimShiftEnter ||
          event.type !== 'keydown' ||
          event.key !== 'Enter' ||
          !event.shiftKey
        ) {
          return false;
        }
        lastHandledShiftEnterAt = performance.now();
        event.preventDefault();
        event.stopPropagation();
        sendInput('\x1b[200~\n\x1b[201~');
        return true;
      };
      terminal.attachCustomKeyEventHandler((event) => !handleShiftEnter(event));

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
        if (performance.now() - lastHandledShiftEnterAt < 50) {
          return;
        }
        handleShiftEnter(event);
      };
      container.addEventListener('keydown', handleTerminalKeyDown, true);

      const forcePrimaryMouseSelection = (event: MouseEvent) => {
        // Isagi favors ordinary drag-to-select/copy for terminal text. Users can
        // still send primary mouse events to tmux-aware apps with Shift-click on
        // macOS or Alt-click elsewhere.
        if (event.button !== 0 || event.altKey || event.shiftKey) {
          return;
        }
        try {
          Object.defineProperty(event, isMacPlatform() ? 'altKey' : 'shiftKey', { value: true });
        } catch {
          // If the browser marks the modifier property non-configurable, users can
          // still force xterm selection with Option on macOS or Shift elsewhere.
        }
      };
      container.addEventListener('mousedown', forcePrimaryMouseSelection, true);

      const handleTerminalCopy = (event: ClipboardEvent) => {
        const selection = terminal.getSelection();
        if (!selection) {
          return;
        }
        event.clipboardData?.setData('text/plain', selection);
        event.preventDefault();
      };
      container.addEventListener('copy', handleTerminalCopy);

      // Register with the transport last, so buffered replay output and the
      // current interactivity state land on a fully wired terminal.
      const sink: PaneTerminalSink = {
        write: (data) => terminal.write(data),
        setInteractive: (running) => {
          terminal.options.disableStdin = !running;
          if (running && focusedRef.current) {
            scheduleTerminalFocus();
          }
        },
        onConnected: () => scheduleResize(),
      };
      const disconnect = transport.connect(sink);
      setTerminalReady(true);

      return () => {
        disposed = true;
        setTerminalReady(false);
        disconnect();
        cancelScheduledFocus();
        if (pendingResizeFrame !== null) {
          window.cancelAnimationFrame(pendingResizeFrame);
        }
        resizeObserver?.disconnect();
        inputDisposable.dispose();
        container.removeEventListener('keydown', handleTerminalKeyDown, true);
        container.removeEventListener('mousedown', forcePrimaryMouseSelection, true);
        container.removeEventListener('copy', handleTerminalCopy);
        terminalRef.current = null;
        terminal.dispose();
      };
    }
  }, [
    transport,
    onRendererWarning,
    disableScrollback,
    shimShiftEnter,
    initiallyInteractive,
    sessionId,
    scheduleTerminalFocus,
    cancelScheduledFocus,
  ]);

  // Focus on becoming focused, and also once the terminal finishes constructing
  // while already focused — a freshly-created pane is focused before its terminal
  // exists, so focusing must wait for `terminalReady` rather than a fixed frame.
  useEffect(() => {
    if (!focused || !terminalReady) {
      return;
    }
    scheduleTerminalFocus();
    return cancelScheduledFocus;
  }, [focused, terminalReady, scheduleTerminalFocus, cancelScheduledFocus]);

  return <div ref={containerRef} className="isagi-xterm isagi-xterm-edge min-h-0 flex-1" />;
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
  // xterm v6 renders the scrollbar as an overlay inside the terminal surface.
  // The stock fit addon reserves scrollbar width for scrollback sessions, which
  // makes OpenCode and other PTYs fit to different visual widths.
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
  const terminalSurface = blendHex(elevated, canvas, 0.5);
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
    // xterm v6 paints its own overlay scrollbar; without these it defaults to
    // foreground at 20% (a pale slab). Match the app's line-token scrollbar:
    // ~34% at rest, ~56% hover, ~66% active. Shape is set in styles.css.
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
