/**
 * The runtime-events connection: one WebSocket per app session that keeps the client's caches and
 * attention state current with what the runtime pushes.
 *
 * `runtimeConnectionAtom` owns the socket. `WorkspacePage` mounts it; unmounting interrupts the
 * connection loop, and the loop's finalizer closes the socket. Each pushed event is decoded and
 * applied by `handleRuntimeEvent`, an app effect whose cases say exactly which resources an event
 * refreshes.
 */
import { Duration, Effect, Exit, Queue, Schema, Stream } from 'effect';
import { AtomRegistry, Reactivity } from 'effect/reactivity';

import {
  runtimeEventInputMessageSchema,
  runtimeEventSchema,
  type CommandStatus,
  type CommandSummary,
  type RuntimeEvent,
  type RuntimeEventInputMessage,
  type WorktreeCommandsOutput,
} from '@isagi/contracts';

import { keys } from '../state/keys.js';
import { patch } from '../state/policy.js';
import { appRuntime } from '../state/runtime.js';
import { cancelWorkbenchFocusPersistence } from './activation.js';
import {
  removeAttentionSource,
  replaceAttentionSources,
  upsertAttentionSource,
} from './attention.js';
import { worktreeCommandsAtom } from './queries.js';
import { resolveRuntimeEventsWebSocketUrl } from './runtime-data.js';
import { forgetPane, forgetSurface } from './store.js';
import { publishTerminalFactEffect } from './terminal-presentation/facts.js';
import { receiveWorkflowSignal } from './workflow/sync.js';

/** First reconnect delay; doubles per failed attempt up to the maximum, reset by an open. */
const INITIAL_RECONNECT_DELAY = Duration.millis(500);
const MAX_RECONNECT_DELAY = Duration.seconds(20);

// --- Applying events --------------------------------------------------------------------------------

/**
 * Apply one pushed runtime event. Every case states what it refreshes; invalidations fire and
 * return (an observed read refetches now, a held but unobserved one is marked stale).
 */
export const handleRuntimeEvent = Effect.fnUntraced(function* (event: RuntimeEvent) {
  const registry = yield* AtomRegistry.AtomRegistry;
  yield* publishTerminalFactEffect({ type: 'runtime_event', event });
  switch (event.type) {
    case 'attention_snapshot':
      replaceAttentionSources(registry, event.payload.sources);
      return;
    case 'attention_source_changed':
      upsertAttentionSource(registry, event.payload);
      return;
    case 'attention_source_removed':
      removeAttentionSource(registry, event.payload.source);
      return;
    // Workflow facts go straight to the workflow layer's live sync, which owns the attached runs
    // and every workflow read; the handler holds none of its own.
    case 'workflow_run_snapshot':
      yield* receiveWorkflowSignal({ type: 'snapshot', summaries: event.payload.summaries });
      return;
    case 'workflow_run_changed':
      yield* receiveWorkflowSignal({ type: 'run_changed', summary: event.payload });
      return;
    case 'workflow_run_event':
      yield* receiveWorkflowSignal({ type: 'run_event', event: event.payload });
      return;
    case 'durable_session_deleted':
      // The terminal coordinator handles it from the published fact; no cached read changes.
      return;
    case 'agent_session_changed':
    case 'terminal_session_changed':
      yield* Reactivity.invalidate([keys.workspace, keys.surface(event.payload.surfaceId)]);
      return;
    case 'editor_context_changed':
      // Surface detail only, unlike the session cases above. An editor status
      // change alters nothing the workspace snapshot carries — not `paneKinds`,
      // not titles, not `activeSurfaceId`. Placement changes still arrive as
      // `surface_changed`, which invalidates both.
      yield* Reactivity.invalidate([keys.surface(event.payload.surfaceId)]);
      return;
    case 'surface_changed':
      yield* Reactivity.invalidate([keys.workspace]);
      if (event.payload.change === 'deleted') {
        // The deleted surface's detail stays cached but is never read again (web-state §2.3
        // delta 5); the local overrides and the focus revision are what must go.
        cancelWorkbenchFocusPersistence(registry, event.payload.worktreeId);
        forgetSurface(registry, event.payload.worktreeId, event.payload.surfaceId);
        forgetPane(registry, event.payload.surfaceId);
        return;
      }
      yield* Reactivity.invalidate([keys.surface(event.payload.surfaceId)]);
      if (event.payload.change === 'pane_deleted') {
        for (const paneId of event.payload.deletedPaneIds) {
          forgetPane(registry, event.payload.surfaceId, paneId);
        }
      }
      return;
    case 'command_changed': {
      // Flip the command's status in the cached catalog right away so its
      // attention dot is honest immediately, then invalidate to reconcile the
      // facts the event does not carry (ports, removed/managed membership). The
      // catalog key is exact, so the other commands' log metadata is spared.
      const { worktreeId, commandName, status } = event.payload;
      patch(registry, worktreeCommandsAtom(worktreeId), (data) =>
        patchCommandStatus(data, commandName, status),
      );
      yield* Reactivity.invalidate([
        keys.commands(worktreeId),
        keys.commandLog(worktreeId, commandName),
      ]);
      return;
    }
  }
});

function patchCommandStatus(
  data: WorktreeCommandsOutput,
  commandName: string,
  status: CommandStatus,
): WorktreeCommandsOutput {
  // Resolved ports belong to an incarnation, and a status-only event cannot
  // vouch for one. On a restart the intermediate stop is suppressed, so the
  // cached entries here belong to the *dead* incarnation — carrying them
  // forward would present a possibly-wrong port as current. Clearing on every
  // transition leaves the refetch as the only route by which authoritative
  // endpoint facts enter the cache.
  //
  // `[]` and not `null`: the patcher must never be able to write the
  // authoritative degraded value, or an ordinary launch would flash the
  // "unavailable for this run" notice during every refetch window.
  const patchCommands = (commands: readonly CommandSummary[]): CommandSummary[] =>
    commands.map((command) =>
      command.name === commandName ? { ...command, status, ports: [] } : command,
    );
  if (data.status === 'configured') {
    return {
      ...data,
      commands: patchCommands(data.commands),
      removedCommands: patchCommands(data.removedCommands),
    };
  }
  return { ...data, managedCommands: patchCommands(data.managedCommands) };
}

// --- The connection ---------------------------------------------------------------------------------

/** The part of a browser `WebSocket` the connection uses; tests pass a fake. */
export interface RuntimeEventsSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

export type OpenRuntimeEventsSocket = (url: string) => RuntimeEventsSocket;

/** `WebSocket.OPEN`, without reading the browser global in node tests. */
const SOCKET_OPEN = 1;

type SocketSignal =
  | { readonly type: 'open'; readonly socket: RuntimeEventsSocket }
  | { readonly type: 'message'; readonly data: unknown };

/**
 * One socket's life as a stream: the callbacks are adapted here, once. The stream ends when the
 * socket closes (an error closes it), and closing the stream's scope closes the socket.
 */
const socketSignals = (open: OpenRuntimeEventsSocket, url: string) =>
  Stream.callback<SocketSignal>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const socket = open(url);
        socket.addEventListener(
          'open',
          () => void Queue.offerUnsafe(queue, { type: 'open', socket }),
        );
        socket.addEventListener(
          'message',
          (event) => void Queue.offerUnsafe(queue, { type: 'message', data: event.data }),
        );
        socket.addEventListener('close', () => void Queue.endUnsafe(queue));
        socket.addEventListener('error', () => socket.close());
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    ),
  );

/**
 * The connection loop: connect, apply what arrives, and after a close (or a URL that cannot be
 * resolved) wait and reconnect with backoff (500 ms doubling to 20 s, reset by a successful open).
 * Runs until interrupted.
 */
export const connectRuntimeEvents = (open: OpenRuntimeEventsSocket) =>
  Effect.gen(function* () {
    let delay = INITIAL_RECONNECT_DELAY;
    for (;;) {
      const url = yield* Effect.exit(resolveRuntimeEventsWebSocketUrl());
      if (Exit.isSuccess(url)) {
        yield* socketSignals(open, url.value).pipe(
          Stream.runForEach((signal) => {
            if (signal.type === 'message') return applyMessage(signal.data);
            delay = INITIAL_RECONNECT_DELAY;
            return onOpen(signal.socket);
          }),
          Effect.ensuring(receiveWorkflowSignal({ type: 'disconnected' })),
        );
      }
      yield* Effect.sleep(delay);
      delay = Duration.min(Duration.times(delay, 2), MAX_RECONNECT_DELAY);
    }
  });

/**
 * On open, in this order: tell the terminal coordinator, ask for the attention snapshot, tell the
 * workflow layer (so open run views re-read what they may have missed while the socket was down),
 * then ask for the attached-run snapshot.
 */
const onOpen = (socket: RuntimeEventsSocket) =>
  Effect.gen(function* () {
    yield* publishTerminalFactEffect({ type: 'runtime_connected' });
    sendRuntimeEventInput(socket, { type: 'attention_snapshot_requested' });
    yield* receiveWorkflowSignal({ type: 'connected' });
    sendRuntimeEventInput(socket, { type: 'workflow_run_snapshot_requested' });
  });

const applyMessage = (data: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(runtimeEventSchema)(JSON.parse(String(data))),
    catch: (error) => error,
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.logError('[workspace] runtime event decode failed', error),
      onSuccess: handleRuntimeEvent,
    }),
  );

function sendRuntimeEventInput(socket: RuntimeEventsSocket, message: RuntimeEventInputMessage) {
  if (socket.readyState !== SOCKET_OPEN) {
    return;
  }
  const encoded = Schema.decodeUnknownSync(runtimeEventInputMessageSchema)(message);
  socket.send(JSON.stringify(encoded));
}

/**
 * The app session's runtime-events connection. Mount it (`useAtomMount`) where the workspace is
 * shown; nothing reads its value.
 */
export const runtimeConnectionAtom = appRuntime.atom(
  connectRuntimeEvents((url) => new WebSocket(url)),
);
