export interface PtyStreamSink {
  /** Write a chunk of PTY output, live or replayed. */
  readonly write: (data: string) => void;
  /** Toggle stdin based on whether this stream is currently writable. */
  readonly setInteractive: (interactive: boolean) => void;
  /** The socket is open: resend the current terminal geometry. */
  readonly onConnected: () => void;
}

export interface PtyStreamSurfaceTransport {
  readonly connect: (sink: PtyStreamSink) => () => void;
}

export interface PtyStreamTransport extends PtyStreamSurfaceTransport {
  readonly sendInput: (data: string) => void;
  readonly sendResize: (cols: number, rows: number) => void;
}

export interface PtyStreamTransportController extends PtyStreamTransport {
  readonly beginAttach: (initialInteractive: boolean) => void;
  readonly bindSocket: (socket: WebSocket) => void;
  readonly handleOpen: () => void;
  readonly setInteractive: (interactive: boolean) => void;
  readonly pushOutput: (data: string) => void;
  readonly freeze: () => void;
  readonly closeSocket: () => void;
}

/**
 * Bridge between the hook-owned websocket and the presentational terminal.
 * Output that arrives before a terminal has registered is buffered and flushed
 * on connect, so no bytes are lost and the renderer stays transport-agnostic.
 */
export function createPtyStreamTransport(): PtyStreamTransportController {
  let socket: WebSocket | null = null;
  let interactive = false;
  let sink: PtyStreamSink | null = null;
  let buffer: string[] = [];
  let frozen = false;

  const isLive = () => socket?.readyState === WebSocket.OPEN && interactive;

  return {
    beginAttach(initialInteractive) {
      socket = null;
      interactive = initialInteractive;
      frozen = false;
      buffer = [];
      sink?.setInteractive(initialInteractive);
    },
    bindSocket(next) {
      socket = next;
    },
    handleOpen() {
      sink?.onConnected();
    },
    setInteractive(next) {
      interactive = next;
      sink?.setInteractive(next);
    },
    pushOutput(data) {
      if (frozen) {
        return;
      }
      if (sink) {
        sink.write(data);
      } else {
        buffer.push(data);
      }
    },
    freeze() {
      frozen = true;
      interactive = false;
      sink?.setInteractive(false);
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
      next.setInteractive(interactive);
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
