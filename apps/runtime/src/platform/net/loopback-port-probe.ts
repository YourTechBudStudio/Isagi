import net from 'node:net';

import { Context, Data, Effect, Layer } from 'effect';

// The only socket code in the runtime. Everything any domain believes about a
// port's availability, it believes because of this file.
//
// It sits in `lib/` and stays there: it imports no runtime domain, renders
// nothing, and formats nothing. Deciding which error classes are safe to *name*
// is domain knowledge (`diagnostics/operational-cause.ts`), so this adapter
// hands its callers a structured cause and lets each one classify at its own
// boundary.
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

/**
 * The two stages that can fail carry the same payload, because the callers do
 * not branch on which one it was: a refused bind and a refused close both mean
 * "this port is not available to hand out". The one place the difference
 * matters is the close-failure warning, and that is emitted at the close site
 * itself rather than reconstructed from a tag nothing else reads.
 *
 * `cause` is structured and unrendered on purpose. It travels to a consumer
 * that knows which error classes are safe to name — the commands adapter below
 * turns it into a `CommandPortAllocationError.detail` — and this module never
 * reads or formats it.
 */
export class LoopbackPortUnavailable extends Data.TaggedError('LoopbackPortUnavailable')<{
  readonly cause: unknown;
}> {}

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
export interface LoopbackPortProbeHooks {
  readonly afterListening?: (port: number) => Effect.Effect<void>;
  /**
   * Holds acquisition open after the bind has landed and before
   * `acquireUseRelease` owns the listener, so a test can interrupt the fiber
   * inside that window.
   *
   * This is the window that looks like a leak and is not: `acquireUseRelease`
   * runs its acquire uninterruptibly, so an interrupt arriving here is
   * *deferred* rather than delivered. The fiber is never gone while the bind is
   * in flight; it completes acquisition, the resource becomes owned, and the
   * interruption is taken at the first interruptible point inside `use`, where
   * `releaseListener` is already installed. That is why this `async` carries no
   * cancellation finalizer — a canceller here would be unreachable code
   * claiming to guard a state the framework does not allow. The test below is
   * what keeps that reasoning honest instead of assumed.
   *
   * It is a promise rather than an `Effect` on purpose: it is awaited inside
   * the `Effect.async` register, which has no fiber to run an effect on.
   * Production supplies nothing and acquisition resumes immediately.
   */
  readonly holdAcquisition?: () => Promise<void>;
  /**
   * Fault-injection seam for the close whose outcome the caller depends on.
   * Production supplies nothing and the supplied `close` runs directly; a test
   * substitutes a failure to exercise the warning branch below.
   *
   * It is deliberately given the close *effect* and nothing else. Handing a
   * test the `net.Server` would turn a lifecycle seam into unrestricted access
   * to the resource this module exists to own — and the release path still
   * closes the listener either way, so a substituted failure leaks nothing.
   */
  readonly closeListener?: (input: {
    readonly close: Effect.Effect<void, LoopbackPortUnavailable>;
  }) => Effect.Effect<void, LoopbackPortUnavailable>;
}

export interface LoopbackPortProbeService {
  /**
   * Best-effort availability check. True only when a loopback bind of the port
   * succeeded *and* its listener finished closing — a port is never reported
   * inactive while this call might still hold it, because the caller's next act
   * is to hand it to a process that must bind it.
   *
   * Exposes no expected failure: a bind refusal is the ordinary "in use"
   * answer, and every other operational fault folds to `false` so that a probe
   * fault on a remembered port cannot kill a launch a fresh assignment could
   * still serve. Interruption is preserved, and genuine defects stay defects.
   */
  readonly probeInactive: (port: number) => Effect.Effect<boolean>;
  /**
   * Bind `127.0.0.1:0`, read the port the operating system assigned, and return
   * it only once the listener has finished closing. Bind and close failures are
   * both `LoopbackPortUnavailable`: a port that may still be held is never
   * handed out.
   */
  readonly obtainEphemeralPort: Effect.Effect<number, LoopbackPortUnavailable>;
}

export const LoopbackPortProbe =
  Context.GenericTag<LoopbackPortProbeService>('isagi/LoopbackPortProbe');

export function makeLoopbackPortProbe(
  hooks: LoopbackPortProbeHooks = {},
): LoopbackPortProbeService {
  const probeInactive = (port: number) =>
    withLoopbackPort(port, hooks).pipe(
      Effect.as(true),
      // Both stages fold to `false`, but only for their own reasons: a bind
      // failure means the port is in use, and a close failure means this file
      // may still hold it. Neither is a launch-ending fact, because a fresh
      // assignment can still serve the endpoint.
      Effect.catchAll(() => Effect.succeed(false)),
    );

  const obtainEphemeralPort = withLoopbackPort(0, hooks);

  return { probeInactive, obtainEphemeralPort };
}

/**
 * The live adapter. Stateless, so the layer is a plain value — but it stays
 * behind a tag because it is real IO that the launch lifecycle's tests must be
 * able to substitute.
 */
export const LoopbackPortProbeLive: Layer.Layer<LoopbackPortProbeService> = Layer.succeed(
  LoopbackPortProbe,
  makeLoopbackPortProbe(),
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
  hooks: LoopbackPortProbeHooks,
): Effect.Effect<number, LoopbackPortUnavailable> {
  return Effect.acquireUseRelease(
    openLoopbackListener(port, hooks),
    (listener) =>
      Effect.gen(function* () {
        const bound = boundPort(listener.server);
        if (bound === null) {
          return yield* new LoopbackPortUnavailable({
            cause: new Error('The loopback listener reported no address after binding.'),
          });
        }
        if (hooks.afterListening) yield* hooks.afterListening(bound);
        const close = closeListener(listener);
        yield* (hooks.closeListener ? hooks.closeListener({ close }) : close).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // Out-of-model: the OS refused to release a listener this process
              // owns. The port is not offered, so this can cost a launch a
              // diagnostic but never a wrong allocation — and the only evidence
              // it happened is this line.
              //
              // The cause is deliberately absent. `console` stringifies its
              // arguments, so passing it — even as a second argument — would
              // publish foreign text into logs that end up in bug reports, and
              // this module holds no classifier that could redact it. The label
              // and the port are both runtime-authored, and they are enough to
              // see the degradation: the caller simply asks for a fresh port.
              console.warn(
                `[runtime] Loopback port probe could not close its listener port=${bound}`,
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
  hooks: LoopbackPortProbeHooks,
): Effect.Effect<LoopbackListener, LoopbackPortUnavailable> {
  return Effect.async<LoopbackListener, LoopbackPortUnavailable>((resume) => {
    const sockets = new Set<net.Socket>();
    let server: net.Server;
    try {
      server = net.createServer();
    } catch (cause) {
      resume(new LoopbackPortUnavailable({ cause }));
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
      resume(new LoopbackPortUnavailable({ cause }));
    };
    const onListening = () => {
      server.removeListener('error', onError);
      // Production resumes here; the hook exists only so a test can hold this
      // exact moment open. See `holdAcquisition` for why no cancellation
      // finalizer belongs on this `async`.
      if (!hooks.holdAcquisition) {
        resume(Effect.succeed(listener));
        return;
      }
      void hooks.holdAcquisition().then(() => resume(Effect.succeed(listener)));
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
      resume(new LoopbackPortUnavailable({ cause }));
    }
  });
}

// The result-sensitive close. Sweeping the socket set first is what bounds the
// callback on process-local work instead of a peer's chosen lifetime.
function closeListener(listener: LoopbackListener): Effect.Effect<void, LoopbackPortUnavailable> {
  return Effect.async<void, LoopbackPortUnavailable>((resume) => {
    try {
      destroyTrackedSockets(listener);
      listener.server.close((cause) => {
        // Only a clean close marks the listener done. A failed one deliberately
        // leaves the flag alone so release still gets its one best-effort
        // retry at the resource this file is responsible for.
        if (!cause) listener.closed = true;
        resume(cause ? new LoopbackPortUnavailable({ cause }) : Effect.void);
      });
    } catch (cause) {
      resume(new LoopbackPortUnavailable({ cause }));
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
