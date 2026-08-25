import net from 'node:net';

import { Effect, Layer } from 'effect';

import { describeOperationalCause } from './commands.diagnostics.js';
import {
  CommandPortAllocationError,
  CommandPortProbe,
  type CommandPortProbeService,
} from './commands.ports.js';

// The only socket code in the runtime. Everything about a port's availability
// that the commands domain believes, it believes because of this file.
//
// Both operations are the same short-lived experiment — bind a loopback
// listener, read the port, let it go — differing only in which port they ask
// for and how they report the outcome. The resource lifecycle therefore exists
// exactly once, in `withLoopbackPort`, and the two public methods are thin
// interpretations of its result.
//
// Two rules make the experiment safe to build a launch on:
//
//  1. **A port is never offered while this file might still hold it.** Success
//     is gated on the listener's close *completing*, not on it being requested.
//     Returning earlier would make the launched command's own bind race this
//     probe's teardown — the exact failure the probe exists to avoid.
//  2. **The probe owns every socket its listener accepts.** `server.close()`
//     stops the listener accepting but waits on connections that already
//     exist, so a stale browser tab still polling a remembered port could
//     otherwise stall teardown for as long as its owner cared to keep it open.
//     Accepted sockets are destroyed on arrival and swept again before close,
//     which leaves the close callback gated only on process-local work.

// The two stages that can fail carry the same payload, because the callers do
// not branch on which one it was: a refused bind and a refused close both mean
// "this port is not available to hand out". The one place the difference
// matters is the close-failure warning, and that is emitted at the close site
// itself rather than reconstructed from a tag nothing else reads.
interface LoopbackListenerFailure {
  readonly cause: unknown;
}

interface LoopbackListener {
  readonly server: net.Server;
  readonly sockets: Set<net.Socket>;
  // Makes release's idempotency structural rather than a bet on Node's
  // behaviour when `close()` is called on an already-closed server.
  closed: boolean;
}

/**
 * Test seam for the adapter's cancellation and connection behaviour.
 *
 * `afterListening` runs while the listener is genuinely bound and before the
 * close, so a test can prove the resource existed before interrupting it — a
 * fork-then-interrupt race could otherwise settle before `listen` ever
 * completed and assert nothing at all. Production supplies no hook.
 */
export interface CommandPortProbeHooks {
  readonly afterListening?: (port: number) => Effect.Effect<void>;
}

export function makeCommandPortProbe(hooks: CommandPortProbeHooks = {}): CommandPortProbeService {
  const probeInactive = (port: number) =>
    withLoopbackPort(port, hooks).pipe(
      Effect.as(true),
      // Both stages fold to `false`, but only for their own reasons: a bind
      // failure means the port is in use, and a close failure means this file
      // may still hold it. Neither is a launch-ending fact, because a fresh
      // assignment can still serve the endpoint.
      Effect.catchAll(() => Effect.succeed(false)),
    );

  const obtainEphemeralPort = withLoopbackPort(0, hooks).pipe(
    Effect.mapError(
      (failure) =>
        new CommandPortAllocationError({
          detail: describeOperationalCause(failure.cause),
        }),
    ),
  );

  return { probeInactive, obtainEphemeralPort };
}

/**
 * The live adapter. Stateless, so the layer is a plain value — but it stays
 * behind a tag because it is real IO that the launch lifecycle's tests must be
 * able to substitute.
 */
export const CommandPortProbeLive: Layer.Layer<CommandPortProbeService> = Layer.succeed(
  CommandPortProbe,
  makeCommandPortProbe(),
);

// Binds `127.0.0.1:<port>`, reads the bound port, and returns it only after the
// listener has confirmably closed. `port: 0` asks the operating system to
// assign one.
//
// The framework decides where each responsibility can live. `acquireUseRelease`
// runs release with a `never` error channel and cannot let it change an
// already-established result, so the close whose outcome the *caller* depends on
// happens inside `use`; release is the infallible fallback that runs on
// interruption, on a failed use, and as one best-effort retry after a failed
// close. Release swallowing a teardown failure never turns a `use`-path close
// failure into a success.
function withLoopbackPort(
  port: number,
  hooks: CommandPortProbeHooks,
): Effect.Effect<number, LoopbackListenerFailure> {
  return Effect.acquireUseRelease(
    openLoopbackListener(port),
    (listener) =>
      Effect.gen(function* () {
        const bound = boundPort(listener.server);
        if (bound === null) {
          return yield* Effect.fail<LoopbackListenerFailure>({
            cause: new Error('The loopback listener reported no address after binding.'),
          });
        }
        if (hooks.afterListening) yield* hooks.afterListening(bound);
        yield* closeListener(listener).pipe(
          Effect.tapError((failure) =>
            Effect.sync(() => {
              // Out-of-model: the OS refused to release a listener this process
              // owns. The port is not offered, so this can cost a launch a
              // diagnostic but never a wrong allocation — and the only evidence
              // it happened is this line.
              console.warn(
                `[runtime] Command port probe could not close its listener port=${bound} cause=${describeOperationalCause(failure.cause)}`,
              );
            }),
          ),
        );
        return bound;
      }),
    (listener) => releaseListener(listener),
  );
}

function openLoopbackListener(
  port: number,
): Effect.Effect<LoopbackListener, LoopbackListenerFailure> {
  return Effect.async<LoopbackListener, LoopbackListenerFailure>((resume) => {
    const sockets = new Set<net.Socket>();
    let server: net.Server;
    try {
      server = net.createServer();
    } catch (cause) {
      resume(Effect.fail({ cause }));
      return;
    }
    const listener: LoopbackListener = { server, sockets, closed: false };

    // The probe never serves traffic, so anything that connects is destroyed
    // immediately. Tracking it until its own `close` fires is what lets the
    // teardown paths sweep a socket that has not finished dying yet.
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.destroy();
    });

    const onError = (cause: unknown) => {
      server.removeListener('listening', onListening);
      resume(Effect.fail({ cause }));
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resume(Effect.succeed(listener));
    };
    server.once('error', onError);
    server.once('listening', onListening);

    try {
      // IPv4 loopback only, by decision: a command that binds another interface
      // or family is the accepted probe/interface skew, not something this
      // adapter guesses at.
      server.listen({ host: '127.0.0.1', port, exclusive: true });
    } catch (cause) {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      resume(Effect.fail({ cause }));
    }
  });
}

// The result-sensitive close. Sweeping the socket set first is what bounds the
// callback on process-local work instead of a peer's chosen lifetime.
function closeListener(listener: LoopbackListener): Effect.Effect<void, LoopbackListenerFailure> {
  return Effect.async<void, LoopbackListenerFailure>((resume) => {
    try {
      destroyTrackedSockets(listener);
      listener.server.close((cause) => {
        // Only a clean close marks the listener done. A failed one deliberately
        // leaves the flag alone so release still gets its one best-effort
        // retry at the resource this file is responsible for.
        if (!cause) listener.closed = true;
        resume(cause ? Effect.fail({ cause }) : Effect.void);
      });
    } catch (cause) {
      resume(Effect.fail({ cause }));
    }
  });
}

// Infallible, idempotent, and bounded by the same socket sweep — an
// uninterruptible finalizer must never be able to wait on a peer.
function releaseListener(listener: LoopbackListener): Effect.Effect<void> {
  return Effect.async<void>((resume) => {
    if (listener.closed) {
      resume(Effect.void);
      return;
    }
    try {
      destroyTrackedSockets(listener);
      listener.server.close(() => {
        listener.closed = true;
        resume(Effect.void);
      });
    } catch {
      resume(Effect.void);
    }
  });
}

function destroyTrackedSockets(listener: LoopbackListener) {
  for (const socket of listener.sockets) socket.destroy();
}

function boundPort(server: net.Server): number | null {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : null;
}
