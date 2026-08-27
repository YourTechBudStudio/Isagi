import assert from 'node:assert/strict';
import net from 'node:net';
import process from 'node:process';
import test from 'node:test';

import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';

import { makeCommandPortProbe } from '../commands.port-probe.js';

/**
 * The live adapter, against real loopback sockets.
 *
 * The claims worth proving here are all resource claims: that a port reported
 * inactive is one the caller can immediately bind, that a returned port is not
 * still held by the probe, that a client connecting during the probe window
 * cannot stall teardown, and that an interrupted probe leaves nothing behind —
 * including when the interruption arrives while a client connection is live,
 * which is the case where the two hazards meet.
 *
 * Interruption is proven through the adapter's `afterListening` seam rather
 * than by racing a fork against an interrupt. The race is the tempting version
 * and it is worthless: `listen` completes in microseconds, so the fiber would
 * usually finish before the interrupt arrived and the test would pass without
 * the listener ever having existed.
 */

const probe = makeCommandPortProbe();

function occupy(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      assert.ok(typeof address === 'object' && address !== null);
      resolve({
        port: address.port,
        release: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

// The strongest available statement that the adapter is not holding the port:
// bind it ourselves, right now, with no retry or grace period.
function assertImmediatelyRebindable(port: number) {
  return new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', (cause) =>
      reject(new Error(`port ${port} was not rebindable: ${String(cause)}`)),
    );
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve());
    });
  });
}

// Connects a client to the probe's listener and records the connection's
// *outcome* on `connected` — success only on a real `connect`, failure on the
// socket's error. Every live-client test barriers on that deferred, so none of
// them can mistake a refused connection for the hazardous state it means to
// create. The socket is recorded rather than closed here: the adapter owns
// every socket it accepts, and that ownership is what these tests exercise.
function connectHeldClient(
  port: number,
  connected: Deferred.Deferred<void, Error>,
  clients: net.Socket[],
) {
  return Effect.async<void>((resume) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    clients.push(socket);
    socket.once('connect', () => resume(Effect.asVoid(Deferred.succeed(connected, undefined))));
    socket.once('error', (cause) => resume(Effect.asVoid(Deferred.fail(connected, cause))));
  });
}

function serverHandleCount() {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'TCPServerWrap').length;
}

// Handles are released a tick or two after the close callback, so counts are
// only meaningful once the loop has drained.
function drain() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test('an occupied port probes as active', async () => {
  const occupied = await occupy();
  try {
    assert.equal(await Effect.runPromise(probe.probeInactive(occupied.port)), false);
  } finally {
    await occupied.release();
  }
});

test('a free port probes as inactive and is immediately rebindable', async () => {
  const occupied = await occupy();
  const port = occupied.port;
  await occupied.release();

  assert.equal(await Effect.runPromise(probe.probeInactive(port)), true);
  // The probe reported the port usable, so the caller must be able to use it
  // without racing the probe's own teardown.
  await assertImmediatelyRebindable(port);
});

test('an assigned port is in range and immediately rebindable', async () => {
  // Deliberately no distinctness assertion between the two: the resolver
  // handles a repeated OS assignment on purpose, so uniqueness is a local
  // observation about this host, not a contract the adapter owes anyone.
  const first = await Effect.runPromise(probe.obtainEphemeralPort);
  const second = await Effect.runPromise(probe.obtainEphemeralPort);

  for (const port of [first, second]) {
    assert.ok(Number.isInteger(port) && port > 0 && port < 65_536);
    await assertImmediatelyRebindable(port);
  }
});

test(
  'a client connected during the probe window cannot stall the close',
  // Bounded for the same reason as the interruption case: the regression is a
  // stall, and an unbounded stall hangs the suite instead of reporting itself.
  { timeout: 5_000 },
  async () => {
    const occupied = await occupy();
    const port = occupied.port;
    await occupied.release();

    const clients: net.Socket[] = [];

    try {
      const connected = await Effect.runPromise(Deferred.make<void, Error>());

      // Hold the listener open and connect to it, so the probe reaches its
      // close with a live connection attached. Without socket ownership,
      // `server.close()` would wait on that connection for as long as its owner
      // chose to keep it.
      const held = makeCommandPortProbe({
        afterListening: (bound) => connectHeldClient(bound, connected, clients),
      });

      const inactive = await Effect.runPromise(held.probeInactive(port));
      // Fails the test if the client never got a connection, so the live-client
      // precondition is enforced rather than assumed.
      await Effect.runPromise(Deferred.await(connected));
      assert.equal(inactive, true);
      await assertImmediatelyRebindable(port);
    } finally {
      for (const socket of clients) socket.destroy();
    }
  },
);

test('an interruption while the listener is bound leaves no listener behind', async () => {
  const occupied = await occupy();
  const port = occupied.port;
  await occupied.release();

  // One program, so the forked fiber has a living parent. Forking from a
  // `runPromise` that returns immediately would let the parent scope close and
  // interrupt the child before the barrier ever mattered.
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const listening = yield* Deferred.make<void>();
      // Never completed. Holding `use` open is the entire point: it guarantees
      // the interruption lands on an acquired listener.
      const proceed = yield* Deferred.make<void>();
      const barriered = makeCommandPortProbe({
        afterListening: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(listening, undefined);
            yield* Deferred.await(proceed);
          }),
      });

      const fiber = yield* Effect.fork(barriered.probeInactive(port));
      // The barrier is what makes this deterministic: by the time it resolves,
      // the real listener is bound, so the interrupt below exercises release
      // rather than a no-op on a resource that never existed.
      yield* Deferred.await(listening);
      return yield* Fiber.interrupt(fiber);
    }),
  );

  assert.ok(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause));
  // Release ran, and it ran to completion — no grace period, no retry.
  await assertImmediatelyRebindable(port);
});

test(
  'an interruption with a client connected leaves no listener behind',
  // Bounded on purpose. The regression this guards against is a *stall*: drop
  // the socket sweep from the release path and the finalizer waits on a peer
  // that never leaves. Without a timeout that failure mode hangs the suite
  // instead of reporting itself.
  { timeout: 5_000 },
  async () => {
    const occupied = await occupy();
    const port = occupied.port;
    await occupied.release();

    // Held outside the program so the test can guarantee its own cleanup even
    // if the adapter fails to destroy what it accepted.
    const clients: net.Socket[] = [];

    try {
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const connected = yield* Deferred.make<void, Error>();
          // Never completed: `use` stays open so the interrupt below lands on a
          // listener that is bound *and* has already accepted a connection.
          const proceed = yield* Deferred.make<void>();
          const barriered = makeCommandPortProbe({
            afterListening: (bound) =>
              Effect.gen(function* () {
                yield* connectHeldClient(bound, connected, clients);
                yield* Deferred.await(proceed);
              }),
          });

          const fiber = yield* Effect.fork(barriered.probeInactive(port));
          // Fails the whole program if the client never got a connection, so
          // the precondition is enforced rather than assumed.
          yield* Deferred.await(connected);
          return yield* Fiber.interrupt(fiber);
        }),
      );

      assert.ok(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause));
      // The whole claim: interruption ran to completion despite a live client,
      // and the port came back with no grace period.
      await assertImmediatelyRebindable(port);
    } finally {
      for (const socket of clients) socket.destroy();
    }
  },
);

test('probeInactive exposes no expected failure and preserves interruption', async () => {
  // The type says `Effect<boolean>`; the two tests above are what make that
  // honest. A bind refusal is an ordinary `false` (occupied-port test) and an
  // interruption stays an interruption rather than being folded into a value.
  const occupied = await occupy();
  try {
    const exit = await Effect.runPromiseExit(probe.probeInactive(occupied.port));
    assert.ok(Exit.isSuccess(exit));
    assert.equal(exit.value, false);
  } finally {
    await occupied.release();
  }
});

test('repeated probes do not accumulate server handles', async () => {
  await drain();
  const baseline = serverHandleCount();

  for (let index = 0; index < 5; index += 1) {
    await Effect.runPromise(probe.obtainEphemeralPort);
    await Effect.runPromise(
      probe.probeInactive(await Effect.runPromise(probe.obtainEphemeralPort)),
    );
  }
  await drain();
  const afterFew = serverHandleCount();

  for (let index = 0; index < 25; index += 1) {
    await Effect.runPromise(probe.obtainEphemeralPort);
  }
  await drain();
  const afterMany = serverHandleCount();

  // The claim is that the count does not grow with iteration count — not that
  // it is literally zero. A handle lingers briefly past its close callback, and
  // the runtime test suite shares one process with every other listener in it,
  // so an absolute assertion would be measuring other tests.
  assert.ok(
    afterMany <= afterFew,
    `server handles grew with iteration count: baseline=${baseline} afterFew=${afterFew} afterMany=${afterMany}`,
  );
});
