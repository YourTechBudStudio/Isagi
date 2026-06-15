import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { Effect } from 'effect';
import { Bot, SquareTerminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type {
  PtySessionMetadata,
  PtySessionStatus,
  PtyWebSocketOutputMessage,
  SurfaceDetail,
  SurfacePane,
} from '@isagi/contracts';

import { AttentionDot } from '../../components/AttentionDot.js';
import { PaneDeleteButton } from '../../components/PaneDeleteButton.js';
import { ptyCopy, ptySocketErrorCopy } from '../../copy/index.js';
import {
  handleDispatchedCommandError,
  useCommandDispatcher,
} from '../../lib/palette/dispatcher.js';
import { resolveActivePaneId } from '../../lib/workspace/model.js';
import { formatRuntimeError, resolvePtyWebSocketUrl } from '../../lib/workspace/runtime-data.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import { calculateTerminalFit } from './ptyFit.js';

interface PtySurfaceProps {
  readonly detail: SurfaceDetail;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';
type SocketNotice = {
  readonly message: string;
  readonly kind: 'protocol' | 'transport';
};
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

export function PtySurface({ detail }: PtySurfaceProps) {
  const storedPaneId = useWorkspaceStore((state) => state.activePaneBySurfaceId[detail.id]);
  const focusPane = useWorkspaceStore((state) => state.focusPane);
  const dispatchCommand = useCommandDispatcher();
  const focusedPaneId = resolveActivePaneId(detail.panes, storedPaneId, detail.activePaneId);

  useEffect(() => {
    if (focusedPaneId !== null && focusedPaneId !== storedPaneId) {
      focusPane(detail.id, focusedPaneId);
    }
  }, [detail.id, focusedPaneId, focusPane, storedPaneId]);

  if (detail.panes.length === 0) {
    return (
      <div className="grid h-full place-items-center rounded-md border border-line/20 bg-elevated/50 backdrop-blur-sm">
        <span className="font-mono text-[12px] text-fg-subtle">{ptyCopy.emptySurface}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-2">
      {detail.panes.map((pane) => (
        <PtyPaneShell
          key={pane.id}
          pane={pane}
          surface={detail}
          focused={pane.id === focusedPaneId}
          onFocus={() => focusPane(detail.id, pane.id)}
          onDelete={() => {
            focusPane(detail.id, pane.id);
            void dispatchCommand('delete-active-pane', {
              worktreeId: String(detail.worktreeId),
              surfaceId: String(detail.id),
              paneId: String(pane.id),
            }).catch(handleDispatchedCommandError);
          }}
        />
      ))}
    </div>
  );
}

function PtyPaneShell({
  pane,
  surface,
  focused,
  onFocus,
  onDelete,
}: {
  readonly pane: SurfacePane;
  readonly surface: SurfaceDetail;
  readonly focused: boolean;
  readonly onFocus: () => void;
  readonly onDelete: () => void;
}) {
  const Icon = surface.kind === 'agent' ? Bot : SquareTerminal;
  const session = pane.ptySession;
  const [liveStatus, setLiveStatus] = useState<PtySessionStatus | null>(session?.status ?? null);
  const [exit, setExit] = useState<{
    readonly exitCode: number | null;
    readonly signal: string | null;
  }>({
    exitCode: session?.exitCode ?? null,
    signal: session?.signal ?? null,
  });
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [rendererWarning, setRendererWarning] = useState<string | null>(null);
  const [socketNotice, setSocketNotice] = useState<SocketNotice | null>(null);
  const status = liveStatus ?? session?.status ?? null;
  const statusReason = session?.statusReason ?? null;

  useEffect(() => {
    setLiveStatus(session?.status ?? null);
    setExit({ exitCode: session?.exitCode ?? null, signal: session?.signal ?? null });
    setSocketNotice(null);
  }, [session?.exitCode, session?.id, session?.signal, session?.status, session?.statusReason]);

  const dimmed = status === 'exited' || status === 'failed' || status === 'killed';
  const errored = status === 'failed';
  const statusReasonNotice = ptyCopy.sessionNotice(status, statusReason);
  const connectionNotice =
    connection === 'error' || connection === 'disconnected'
      ? ptySocketErrorCopy.byReason(
          connection === 'error' ? 'socket_unavailable' : 'socket_disconnected',
        )
      : null;
  const paneNotice =
    (socketNotice?.kind === 'protocol' ? socketNotice.message : null) ??
    statusReasonNotice ??
    socketNotice?.message ??
    connectionNotice ??
    rendererWarning;

  return (
    <section
      aria-label={pane.title}
      onPointerDown={onFocus}
      className={`group relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-elevated/50 backdrop-blur-sm transition-opacity duration-ui ease-expo ${
        focused ? 'opacity-100' : 'opacity-55'
      } ${errored ? 'border-error/35' : focused ? 'border-blue/40' : 'border-line/20'} ${
        dimmed ? 'bg-elevated/38' : ''
      }`}
    >
      <div className="flex min-h-9 items-center gap-2 border-b border-line/15 px-3 py-2">
        <Icon size={13} className="text-fg-subtle" />
        <AttentionDot state={pane.attention} />
        <span className="truncate font-mono text-[11.5px] text-fg-muted">{pane.title}</span>
        <span className="ml-auto truncate font-mono text-[10.5px] text-fg-subtle">
          {session ? ptyCopy.sessionStatus(status, statusReason, exit) : ptyCopy.noSession}
        </span>
      </div>
      {paneNotice ? (
        <div className="border-b border-line/12 px-3 py-1.5 font-mono text-[10.5px] text-fg-subtle">
          {paneNotice}
        </div>
      ) : null}
      {session ? (
        <XtermPane
          key={session.id}
          session={session}
          focused={focused}
          onConnectionChange={setConnection}
          onExit={setExit}
          onRendererWarning={setRendererWarning}
          onSocketNotice={setSocketNotice}
          onStatusChange={setLiveStatus}
        />
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center px-4">
          <span className="font-mono text-[12px] text-fg-subtle">{ptyCopy.emptyPane}</span>
        </div>
      )}
      <PaneDeleteButton onDelete={onDelete} />
    </section>
  );
}

function XtermPane({
  session,
  focused,
  onConnectionChange,
  onExit,
  onRendererWarning,
  onSocketNotice,
  onStatusChange,
}: {
  readonly session: PtySessionMetadata;
  readonly focused: boolean;
  readonly onConnectionChange: (state: ConnectionState) => void;
  readonly onExit: (exit: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  }) => void;
  readonly onRendererWarning: (message: string | null) => void;
  readonly onSocketNotice: (notice: SocketNotice | null) => void;
  readonly onStatusChange: (status: PtySessionStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const statusRef = useRef<PtySessionStatus>(session.status);
  const socketRef = useRef<WebSocket | null>(null);
  const disableScrollback = session.harness === 'opencode';

  useEffect(() => {
    statusRef.current = session.status;
    onStatusChange(session.status);
  }, [onStatusChange, session.status]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let pendingResizeFrame: number | null = null;
    let warnedFitUnavailable = false;
    const terminalFontFamily = terminalFontFamilyFromElement(container);
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      disableStdin: session.status !== 'running',
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
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && statusRef.current === 'running') {
        terminal.scrollToBottom();
        socket.send(JSON.stringify({ type: 'input', data }));
      }
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
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN && statusRef.current === 'running') {
          socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        }
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
            ptySessionId: session.id,
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
    const shouldShimShiftEnter = session.purpose === 'agent';
    const handleShiftEnter = (event: KeyboardEvent) => {
      if (
        !shouldShimShiftEnter ||
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

    onConnectionChange('connecting');
    onSocketNotice(null);
    void Effect.runPromise(resolvePtyWebSocketUrl(session.id)).then(
      (url) => {
        if (disposed) {
          return;
        }
        const socket = new WebSocket(url);
        socketRef.current = socket;
        socket.addEventListener('open', () => {
          onSocketNotice(null);
          onConnectionChange('connected');
          sendResize();
        });
        socket.addEventListener('message', (event) => {
          const message = decodeSocketMessage(event.data);
          if (!message) {
            onSocketNotice({
              message: ptySocketErrorCopy.byReason('invalid_message'),
              kind: 'protocol',
            });
            onConnectionChange('error');
            return;
          }
          switch (message.type) {
            case 'session':
              statusRef.current = message.status;
              terminal.options.disableStdin = message.status !== 'running';
              onStatusChange(message.status);
              onExit({
                exitCode: message.exitCode ?? null,
                signal: message.signal ?? null,
              });
              break;
            case 'output':
              terminal.write(message.data);
              break;
            case 'exit': {
              const status =
                message.exitCode === 0 && message.signal === null ? 'exited' : 'failed';
              statusRef.current = status;
              terminal.options.disableStdin = true;
              onStatusChange(status);
              onExit({ exitCode: message.exitCode, signal: message.signal });
              break;
            }
            case 'error':
              onSocketNotice({
                message: ptySocketErrorCopy.byReason(message.code),
                kind: 'protocol',
              });
              onConnectionChange('error');
              break;
            case 'replay_start':
            case 'replay_end':
              break;
          }
        });
        socket.addEventListener('close', () => {
          if (!disposed) {
            onConnectionChange('disconnected');
          }
        });
        socket.addEventListener('error', () => {
          onSocketNotice({
            message: ptySocketErrorCopy.byReason('socket_unavailable'),
            kind: 'transport',
          });
          onConnectionChange('error');
        });
      },
      (error: unknown) => {
        if (!disposed) {
          const runtimeError = formatRuntimeError(error);
          onSocketNotice({ message: runtimeError, kind: 'transport' });
          onConnectionChange('error');
          terminal.write(ptySocketErrorCopy.connectFailed(runtimeError));
        }
      },
    );

    return () => {
      disposed = true;
      if (pendingResizeFrame !== null) {
        window.cancelAnimationFrame(pendingResizeFrame);
      }
      resizeObserver?.disconnect();
      inputDisposable.dispose();
      container.removeEventListener('keydown', handleTerminalKeyDown, true);
      container.removeEventListener('mousedown', forcePrimaryMouseSelection, true);
      container.removeEventListener('copy', handleTerminalCopy);
      socketRef.current?.close();
      socketRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [
    onConnectionChange,
    onExit,
    onRendererWarning,
    onSocketNotice,
    onStatusChange,
    disableScrollback,
    session.id,
    session.purpose,
    session.status,
  ]);

  useEffect(() => {
    if (!focused) {
      return;
    }
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!cancelled) {
          terminalRef.current?.focus();
        }
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [focused]);

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

function decodeSocketMessage(data: unknown) {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    return JSON.parse(data) as PtyWebSocketOutputMessage;
  } catch {
    return null;
  }
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
