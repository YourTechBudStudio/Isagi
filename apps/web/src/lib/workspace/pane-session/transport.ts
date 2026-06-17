import type { SessionStatus } from '@isagi/contracts';

/**
 * What the presentational terminal registers to receive the live stream. The
 * transport pushes output and status here; the terminal never touches the
 * socket directly.
 */
export interface PaneTerminalSink {
  /** Write a chunk of PTY output (live or replayed). */
  readonly write: (data: string) => void;
  /** Toggle stdin based on whether the backing process is running. */
  readonly setInteractive: (running: boolean) => void;
  /** The socket is open: (re)send the current terminal geometry. */
  readonly onConnected: () => void;
}

/**
 * The handle the terminal uses to talk to the (hook-owned) websocket. Sends are
 * gated on an open socket and a running process, so the terminal can call them
 * unconditionally.
 */
export interface PaneTransport {
  readonly connect: (sink: PaneTerminalSink) => () => void;
  readonly sendInput: (data: string) => void;
  readonly sendResize: (cols: number, rows: number) => void;
}

/** The private surface `usePaneSession` drives as it owns the websocket. */
export interface PaneTransportController extends PaneTransport {
  readonly beginAttach: (initialStatus: SessionStatus) => void;
  readonly bindSocket: (socket: WebSocket) => void;
  readonly handleOpen: () => void;
  readonly setStatus: (status: SessionStatus) => void;
  readonly pushOutput: (data: string) => void;
  readonly closeSocket: () => void;
}

/**
 * The bridge between the hook-owned websocket and the presentational terminal.
 * Output that arrives before a terminal has registered (e.g. a replay racing the
 * mount) is buffered and flushed on `connect`, so no bytes are lost and the
 * terminal stays free of any connection logic.
 */
export function createPaneTransport(): PaneTransportController {
  let socket: WebSocket | null = null;
  let status: SessionStatus = 'starting';
  let sink: PaneTerminalSink | null = null;
  let buffer: string[] = [];

  const isLive = () => socket?.readyState === WebSocket.OPEN && status === 'running';

  return {
    beginAttach(initialStatus) {
      // A new attach: drop output buffered for the previous socket and reset the
      // gate so input stays disabled until the new process reports it is running.
      socket = null;
      status = initialStatus;
      buffer = [];
    },
    bindSocket(next) {
      socket = next;
    },
    handleOpen() {
      sink?.onConnected();
    },
    setStatus(next) {
      status = next;
      sink?.setInteractive(next === 'running');
    },
    pushOutput(data) {
      if (sink) {
        sink.write(data);
      } else {
        buffer.push(data);
      }
    },
    closeSocket() {
      socket?.close();
      socket = null;
    },
    sendInput(data) {
      if (isLive()) {
        socket?.send(JSON.stringify({ type: 'input', data }));
      }
    },
    sendResize(cols, rows) {
      if (isLive()) {
        socket?.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    },
    connect(next) {
      sink = next;
      for (const chunk of buffer) {
        next.write(chunk);
      }
      buffer = [];
      next.setInteractive(status === 'running');
      if (socket?.readyState === WebSocket.OPEN) {
        next.onConnected();
      }
      return () => {
        if (sink === next) {
          sink = null;
        }
      };
    },
  };
}
