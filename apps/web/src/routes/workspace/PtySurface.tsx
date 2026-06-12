import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { Effect } from 'effect';
import { Bot, SquareTerminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type {
  PtySessionMetadata,
  PtySessionStatus,
  SurfaceDetail,
  SurfacePane,
} from '@isagi/contracts';

import { AttentionDot } from '../../components/AttentionDot.js';
import { formatRuntimeError, resolvePtyWebSocketUrl } from '../../lib/workspace/runtime-data.js';

interface PtySurfaceProps {
  readonly detail: SurfaceDetail;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export function PtySurface({ detail }: PtySurfaceProps) {
  const [focusedPaneId, setFocusedPaneId] = useState(
    detail.activePaneId ?? detail.panes[0]?.id ?? null,
  );

  useEffect(() => {
    if (focusedPaneId && detail.panes.some((pane) => pane.id === focusedPaneId)) {
      return;
    }
    setFocusedPaneId(detail.activePaneId ?? detail.panes[0]?.id ?? null);
  }, [detail.activePaneId, detail.panes, focusedPaneId]);

  if (detail.panes.length === 0) {
    return (
      <div className="grid h-full place-items-center rounded-md border border-line/20 bg-elevated/50 backdrop-blur-sm">
        <span className="font-mono text-[12px] text-fg-subtle">No panes on this surface.</span>
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
          onFocus={() => setFocusedPaneId(pane.id)}
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
}: {
  readonly pane: SurfacePane;
  readonly surface: SurfaceDetail;
  readonly focused: boolean;
  readonly onFocus: () => void;
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
  const [socketError, setSocketError] = useState<string | null>(null);
  const status = liveStatus ?? session?.status ?? null;

  useEffect(() => {
    setLiveStatus(session?.status ?? null);
    setExit({ exitCode: session?.exitCode ?? null, signal: session?.signal ?? null });
    setSocketError(null);
  }, [session?.exitCode, session?.id, session?.signal, session?.status]);

  const dimmed = status === 'exited' || status === 'failed';
  const errored = status === 'failed';
  const paneNotice =
    socketError ??
    (connection === 'error' || connection === 'disconnected'
      ? connectionCopy(connection)
      : rendererWarning);

  return (
    <section
      aria-label={pane.title}
      onPointerDown={onFocus}
      className={`relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-elevated/50 backdrop-blur-sm transition-opacity duration-ui ease-expo ${
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
          {session ? sessionStatusCopy(status, exit) : 'No session'}
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
          onConnectionChange={setConnection}
          onExit={setExit}
          onRendererWarning={setRendererWarning}
          onSocketError={setSocketError}
          onStatusChange={setLiveStatus}
        />
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center px-4">
          <span className="font-mono text-[12px] text-fg-subtle">
            This pane has no PTY session.
          </span>
        </div>
      )}
    </section>
  );
}

function XtermPane({
  session,
  onConnectionChange,
  onExit,
  onRendererWarning,
  onSocketError,
  onStatusChange,
}: {
  readonly session: PtySessionMetadata;
  readonly onConnectionChange: (state: ConnectionState) => void;
  readonly onExit: (exit: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  }) => void;
  readonly onRendererWarning: (message: string | null) => void;
  readonly onSocketError: (message: string | null) => void;
  readonly onStatusChange: (status: PtySessionStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<PtySessionStatus>(session.status);
  const socketRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const edgeToEdge = session.harness === 'opencode';

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
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      disableStdin: session.status !== 'running',
      fontFamily: '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      ...(edgeToEdge ? { scrollback: 0 } : {}),
      theme: terminalThemeFromTokens(),
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(container);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        onRendererWarning('WebGL renderer fell back to canvas.');
      });
      terminal.loadAddon(webgl);
      onRendererWarning(null);
    } catch {
      onRendererWarning('WebGL renderer unavailable; using canvas.');
    }

    const sendResize = () => {
      try {
        fit.fit();
        if (edgeToEdge) {
          terminal.resize(terminal.cols + 1, terminal.rows + 1);
        }
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN && statusRef.current === 'running') {
          socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        }
      } catch {
        // xterm can briefly report zero-size geometry while the canvas is animating.
      }
    };

    resizeObserver = new ResizeObserver(sendResize);
    resizeObserver.observe(container);
    window.setTimeout(sendResize, 0);

    const inputDisposable = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && statusRef.current === 'running') {
        socket.send(JSON.stringify({ type: 'input', data }));
      }
    });

    onConnectionChange('connecting');
    onSocketError(null);
    void Effect.runPromise(resolvePtyWebSocketUrl(session.id)).then(
      (url) => {
        if (disposed) {
          return;
        }
        const socket = new WebSocket(url);
        socketRef.current = socket;
        socket.addEventListener('open', () => {
          onSocketError(null);
          onConnectionChange('connected');
          sendResize();
        });
        socket.addEventListener('message', (event) => {
          const message = decodeSocketMessage(event.data);
          if (!message) {
            onSocketError('Invalid PTY socket message.');
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
              onSocketError(message.message);
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
          onSocketError('PTY socket unavailable.');
          onConnectionChange('error');
        });
      },
      (error: unknown) => {
        if (!disposed) {
          onSocketError(formatRuntimeError(error));
          onConnectionChange('error');
          terminal.write(`Could not connect to PTY session: ${formatRuntimeError(error)}\r\n`);
        }
      },
    );

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      inputDisposable.dispose();
      socketRef.current?.close();
      socketRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
  }, [
    onConnectionChange,
    onExit,
    onRendererWarning,
    onSocketError,
    onStatusChange,
    edgeToEdge,
    session.id,
    session.status,
  ]);

  return (
    <div
      ref={containerRef}
      className={`isagi-xterm min-h-0 flex-1 ${edgeToEdge ? 'isagi-xterm-edge' : 'px-3 py-2'}`}
    />
  );
}

function decodeSocketMessage(data: unknown) {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    return JSON.parse(data) as
      | {
          readonly type: 'session';
          readonly status: PtySessionStatus;
          readonly exitCode?: number | null;
          readonly signal?: string | null;
        }
      | { readonly type: 'replay_start'; readonly bytes: number }
      | { readonly type: 'output'; readonly data: string; readonly replay?: boolean }
      | { readonly type: 'replay_end' }
      | { readonly type: 'exit'; readonly exitCode: number | null; readonly signal: string | null }
      | { readonly type: 'error'; readonly message: string };
  } catch {
    return null;
  }
}

function terminalThemeFromTokens() {
  const styles = window.getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  const canvas = token('--color-canvas');
  const elevated = token('--color-elevated');
  const terminalSurface = blendHex(elevated, canvas, 0.5);
  const fg = token('--color-fg');
  const fgSubtle = token('--color-fg-subtle');
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

function sessionStatusCopy(
  status: PtySessionStatus | null,
  exit: { readonly exitCode: number | null; readonly signal: string | null },
) {
  switch (status) {
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'exited':
      return exit.exitCode === null ? 'Exited' : `Exited with code ${exit.exitCode}`;
    case 'failed':
      if (exit.exitCode !== null) {
        return `Failed with code ${exit.exitCode}`;
      }
      if (exit.signal) {
        return `Stopped by ${exit.signal}`;
      }
      return 'Failed to start';
    default:
      return 'Unknown';
  }
}

function connectionCopy(connection: ConnectionState) {
  switch (connection) {
    case 'error':
      return 'PTY socket unavailable.';
    case 'disconnected':
      return 'PTY socket disconnected.';
    default:
      return '';
  }
}
