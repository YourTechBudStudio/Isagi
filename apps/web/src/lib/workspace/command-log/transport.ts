interface CommandLogTerminalSink {
  readonly write: (data: string) => void;
  readonly setInteractive: (interactive: boolean) => void;
  readonly onConnected: () => void;
}

export interface CommandLogTransport {
  readonly connect: (sink: CommandLogTerminalSink) => () => void;
  readonly pushOutput: (data: string) => void;
  readonly freeze: () => void;
}

export function createCommandLogTransport(): CommandLogTransport {
  let sink: CommandLogTerminalSink | null = null;
  let buffer: string[] = [];
  let frozen = false;

  return {
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
      sink?.setInteractive(false);
    },
    connect(next) {
      sink = next;
      for (const chunk of buffer) {
        next.write(chunk);
      }
      buffer = [];
      next.setInteractive(false);
      next.onConnected();
      return () => {
        if (sink === next) {
          sink = null;
        }
      };
    },
  };
}
