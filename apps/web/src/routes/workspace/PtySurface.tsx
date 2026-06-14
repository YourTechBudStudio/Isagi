import { FitAddon } from '@xterm/addon-fit';
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

interface PtySurfaceProps {
  readonly detail: SurfaceDetail;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';
type SocketNotice = {
  readonly message: string;
  readonly kind: 'protocol' | 'transport';
};

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
  onConnectionChange,
  onExit,
  onRendererWarning,
  onSocketNotice,
  onStatusChange,
}: {
  readonly session: PtySessionMetadata;
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
        onRendererWarning(ptyCopy.renderer.webglFallback);
      });
      terminal.loadAddon(webgl);
      onRendererWarning(null);
    } catch {
      onRendererWarning(ptyCopy.renderer.webglUnavailable);
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
    onSocketNotice,
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
    return JSON.parse(data) as PtyWebSocketOutputMessage;
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
