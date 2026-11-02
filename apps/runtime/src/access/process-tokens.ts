import { randomBytes } from 'node:crypto';

import { Context, Effect, Layer, Stream } from 'effect';

import { InternalEvents } from '../platform/events/index.js';

/**
 * Who holds a process token: a PTY process by its id, or an SDK execution (one Fluidcast session's worker and probe)
 * by its id. Opaque to the launchers, so the PTY layer stays generic.
 */
export type ProcessTokenHolder =
  | { readonly _tag: 'pty'; readonly ptyProcessId: number }
  | { readonly _tag: 'sdk'; readonly executionId: string };

const holderKey = (holder: ProcessTokenHolder) =>
  holder._tag === 'pty' ? `pty:${holder.ptyProcessId}` : `sdk:${holder.executionId}`;

const make = Effect.gen(function* () {
  const events = yield* InternalEvents;
  /** token → holder key, and holder key → token; single-threaded, so no lock. In memory only. */
  const byToken = new Map<string, string>();
  const byHolder = new Map<string, string>();

  const release = (holder: ProcessTokenHolder) =>
    Effect.sync(() => {
      const key = holderKey(holder);
      const token = byHolder.get(key);
      if (token === undefined) return;
      byHolder.delete(key);
      byToken.delete(token);
    });

  // Subscribed during the build, before any PTY can launch (the bus's "never subscribe lazily" rule). Every terminal
  // PTY transition publishes one of these through one chokepoint, so a PTY's token dies with it.
  const ended = yield* events.subscribe([
    'pty_process_exited',
    'pty_process_killed',
    'pty_process_failed',
  ]);
  yield* ended.pipe(
    Stream.runForEach((event) => release({ _tag: 'pty', ptyProcessId: event.ptyProcessId })),
    Effect.forkScoped,
  );

  return ProcessTokens.of({
    issue: (holder) =>
      Effect.sync(() => {
        const key = holderKey(holder);
        const existing = byHolder.get(key);
        if (existing !== undefined) return existing;
        const token = randomBytes(32).toString('hex');
        byHolder.set(key, token);
        byToken.set(token, key);
        return token;
      }),
    release,
    isLive: (token) => token !== '' && byToken.has(token),
  });
});

/**
 * The bearer tokens of processes the runtime launched (`ISAGI_RUNTIME_TOKEN`), one per holder, released when the
 * holder ends: PTYs through their end events, SDK executions by their owner. Lost with the runtime by design, so a
 * process that outlives a restart (an adopted tmux session) loses CLI access.
 */
export class ProcessTokens extends Context.Service<
  ProcessTokens,
  {
    /** Idempotent per holder: the same holder gets the same token until released. */
    readonly issue: (holder: ProcessTokenHolder) => Effect.Effect<string>;
    /** Idempotent; an unknown holder is a no-op. */
    readonly release: (holder: ProcessTokenHolder) => Effect.Effect<void>;
    /** Synchronous: the access guard calls it on every bearer request. */
    readonly isLive: (token: string) => boolean;
  }
>()('isagi/runtime/access/ProcessTokens') {
  static readonly layerNoDeps = Layer.effect(ProcessTokens, make);
  /** One value, shared by reference by every layer that provides it, so the build makes one instance. */
  static readonly layer = ProcessTokens.layerNoDeps.pipe(Layer.provide(InternalEvents.layer));
}
