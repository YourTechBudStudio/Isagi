import { Effect } from 'effect';
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { runRuntimeEffect } from '../../runtime/run.js';
import {
  initialPtyStreamConnectionState,
  ptyStreamConnectionEventForMessage,
  ptyStreamConnectionReducer,
  type PtyStreamConnectionState,
  type PtyStreamSharedMessage,
} from './connection.js';
import {
  createPtyStreamTransport,
  type PtyStreamTransport,
  type PtyStreamTransportController,
} from './transport.js';

type PtyStreamMessage = { readonly type: string };

type TransportFailure = {
  readonly message: string;
  readonly output?: string | undefined;
};

export type UsePtyStreamInput<Message extends PtyStreamMessage> = {
  readonly enabled: boolean;
  readonly resetKey: string;
  readonly connectKey: string;
  readonly initialInteractive: boolean;
  readonly resolveUrl: () => Effect.Effect<string, unknown>;
  readonly decodeMessage: (data: unknown) => Message | null;
  readonly onDomainMessage: (message: Message, transport: PtyStreamTransportController) => void;
  readonly onExit: (
    exit: { readonly exitCode: number | null; readonly signal: string | null },
    transport: PtyStreamTransportController,
  ) => void;
  readonly onResolveError: (error: unknown) => TransportFailure;
  readonly onSocketError: () => TransportFailure;
};

export type UsePtyStreamResult = {
  readonly transport: PtyStreamTransport;
  readonly connection: PtyStreamConnectionState;
};

export function usePtyStream<Message extends PtyStreamMessage>({
  enabled,
  resetKey,
  connectKey,
  initialInteractive,
  resolveUrl,
  decodeMessage,
  onDomainMessage,
  onExit,
  onResolveError,
  onSocketError,
}: UsePtyStreamInput<Message>): UsePtyStreamResult {
  const transportRef = useRef<PtyStreamTransportController | null>(null);
  if (transportRef.current === null) {
    transportRef.current = createPtyStreamTransport();
  }
  const transport = transportRef.current;
  const [connection, dispatch] = useReducer(
    ptyStreamConnectionReducer,
    initialPtyStreamConnectionState,
  );
  const resolveUrlRef = useRef(resolveUrl);
  const decodeMessageRef = useRef(decodeMessage);
  const onDomainMessageRef = useRef(onDomainMessage);
  const onExitRef = useRef(onExit);
  const onResolveErrorRef = useRef(onResolveError);
  const onSocketErrorRef = useRef(onSocketError);

  useEffect(() => {
    resolveUrlRef.current = resolveUrl;
    decodeMessageRef.current = decodeMessage;
    onDomainMessageRef.current = onDomainMessage;
    onExitRef.current = onExit;
    onResolveErrorRef.current = onResolveError;
    onSocketErrorRef.current = onSocketError;
  }, [decodeMessage, onDomainMessage, onExit, onResolveError, onSocketError, resolveUrl]);

  useEffect(() => {
    dispatch({ type: 'reset' });
  }, [resetKey]);

  const failTransport = useCallback(
    (failure: TransportFailure) => {
      transport.freeze();
      dispatch({ type: 'errored', notice: { kind: 'transport', message: failure.message } });
      if (failure.output) {
        transport.pushOutput(failure.output);
      }
    },
    [transport],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let disposed = false;

    dispatch({ type: 'connect_started' });
    transport.beginAttach(initialInteractive);

    void runRuntimeEffect(resolveUrlRef.current()).then(
      (url) => {
        if (disposed) {
          return;
        }
        const socket = new WebSocket(url);
        transport.bindSocket(socket);

        socket.addEventListener('open', () => {
          dispatch({ type: 'socket_open' });
          transport.handleOpen();
        });
        socket.addEventListener('message', (event) => {
          const message = decodeMessageRef.current(event.data);
          if (!message) {
            transport.freeze();
            dispatch({
              type: 'errored',
              notice: { kind: 'protocol', code: 'invalid_message' },
            });
            transport.closeSocket();
            return;
          }
          switch (message.type) {
            case 'output':
              transport.pushOutput((message as unknown as { readonly data: string }).data);
              return;
            case 'exit': {
              const exit = message as unknown as {
                readonly exitCode: number | null;
                readonly signal: string | null;
              };
              transport.freeze();
              dispatch({ type: 'stream_exited' });
              onExitRef.current({ exitCode: exit.exitCode, signal: exit.signal }, transport);
              transport.closeSocket();
              return;
            }
            case 'error': {
              const phaseEvent = ptyStreamConnectionEventForMessage(
                message as PtyStreamSharedMessage,
              );
              if (phaseEvent) {
                dispatch(phaseEvent);
              }
              transport.freeze();
              transport.closeSocket();
              return;
            }
            case 'replay_start':
            case 'replay_end': {
              const phaseEvent = ptyStreamConnectionEventForMessage(
                message as PtyStreamSharedMessage,
              );
              if (phaseEvent) {
                dispatch(phaseEvent);
              }
              return;
            }
            default:
              onDomainMessageRef.current(message, transport);
          }
        });
        socket.addEventListener('close', () => {
          if (!disposed) {
            dispatch({ type: 'socket_closed' });
          }
        });
        socket.addEventListener('error', () => {
          failTransport(onSocketErrorRef.current());
          transport.closeSocket();
        });
      },
      (error: unknown) => {
        if (disposed) {
          return;
        }
        failTransport(onResolveErrorRef.current(error));
      },
    );

    return () => {
      disposed = true;
      transport.closeSocket();
    };
  }, [connectKey, enabled, failTransport, initialInteractive, transport]);

  return { transport, connection };
}
