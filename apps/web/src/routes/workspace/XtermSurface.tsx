import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ptyCopy } from '../../copy/index.js';
import type {
  PtyStreamSink,
  PtyStreamSurfaceTransport,
} from '../../lib/workspace/pty-stream/index.js';
import { loadTerminalFonts, terminalInitOptions } from '../../lib/workspace/terminal-appearance.js';
import {
  clearTerminalRenderCache,
  measureTerminalFit,
} from '../../lib/workspace/terminal-geometry.js';

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
  const interactiveRef = useRef(initiallyInteractive);
  const [ready, setReady] = useState(false);

  const setSurfaceReady = useCallback(
    (next: boolean) => {
      setReady(next);
      onReadyChange?.(next);
    },
    [onReadyChange],
  );

  useEffect(() => {
    interactiveRef.current = initiallyInteractive;
  }, [initiallyInteractive]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    let teardown: (() => void) | undefined;

    void loadTerminalFonts().then(() => {
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
      const terminal = new Terminal(
        terminalInitOptions({
          disableStdin: !initiallyInteractive || !onInput,
          ...(disableScrollback ? { scrollback: 0 } : {}),
        }),
      );
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

      fit();
      const sink: PtyStreamSink = {
        write: (data) => terminal.write(data),
        setInteractive: (interactive) => {
          interactiveRef.current = interactive;
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
  const size = measureTerminalFit(terminal, host);
  if (!size) {
    return 'unready';
  }

  if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
    clearTerminalRenderCache(terminal);
    terminal.resize(size.cols, size.rows);
  }
  return 'fit';
}
