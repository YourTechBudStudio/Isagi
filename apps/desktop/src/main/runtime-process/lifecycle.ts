// The managed (or external) runtime the desktop talks to, as one scoped service.
//
// The child process's Node callbacks are adapted once, at spawn: listeners only forward log lines or complete
// Deferreds. Everything else (readiness, health, the post-ready watch, termination) is one supervising fiber forked
// into the layer's scope, so closing that scope (disposing the desktop runtime) always stops the child.
import {
  Cause,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  SubscriptionRef,
} from 'effect';

import {
  HOST_RUNTIME_STATUS_PROTOCOL_VERSION,
  type HostRuntimeDiagnostic,
  type HostRuntimeFailureReason,
  type HostRuntimeStatusSnapshot,
} from '@isagi/contracts';

import { LosslessLineDecoder, type DecodedLine } from './line-decoder.js';
import type { RuntimeLogSink, RuntimeLogStream } from './logging.js';
import type {
  RuntimeChildProcess,
  RuntimeProcessAdapter,
  RuntimeSpawnSpecification,
} from './process-adapter.js';

const readyPrefix = 'ISAGI_RUNTIME_READY ';

/** How long `terminate` keeps watching after `SIGKILL` before it gives up on observing the exit. */
const killObservationWindow = Duration.seconds(1);

type ManagedFailureReason = Exclude<HostRuntimeFailureReason, 'external_health_check_failed'>;

export class RuntimeLifecycleFailure extends Data.TaggedError('RuntimeLifecycleFailure')<{
  readonly reason: ManagedFailureReason;
  readonly diagnostic: HostRuntimeDiagnostic;
}> {
  override get message() {
    return this.diagnostic.message ?? this.reason;
  }
}

export type RuntimeTarget =
  | {
      readonly ownership: 'managed';
      /**
       * Resolves what to spawn. A `RuntimeLifecycleFailure` keeps its reason; anything thrown (a defect) is reported
       * as `stage_invalid`.
       */
      readonly prepare: Effect.Effect<RuntimeSpawnSpecification, RuntimeLifecycleFailure>;
    }
  | {
      readonly ownership: 'external';
      readonly url: string;
    };

/** Everything platform-shaped the runtime process needs; `runtime.ts` builds it from Electron, tests from fakes. */
export class RuntimeProcessConfig extends Context.Service<
  RuntimeProcessConfig,
  {
    readonly target: RuntimeTarget;
    readonly adapter: RuntimeProcessAdapter;
    /**
     * Succeeds once `url` serves a healthy runtime API. Its failure message becomes the `health_check_failed`
     * diagnostic (managed) or, with URLs redacted, a log line (external).
     */
    readonly checkHealth: (url: string) => Effect.Effect<void, Error>;
    /** Where the child's own stdout/stderr lines go. A protocol (supervisor records, `[runtime]` lines), not a log. */
    readonly log: RuntimeLogSink;
    /** From spawn until the ready line. */
    readonly readinessTimeout: Duration.Duration;
    /** From `SIGTERM` until `SIGKILL`. */
    readonly stopGrace: Duration.Duration;
  }
>()('isagi/desktop/runtime-process/RuntimeProcessConfig') {}

type SnapshotFacts = HostRuntimeStatusSnapshot extends infer Snapshot
  ? Snapshot extends HostRuntimeStatusSnapshot
    ? Omit<Snapshot, 'protocolVersion' | 'revision'>
    : never
  : never;

interface ExitFacts {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A spawned child with its listeners attached. Every field is completed by a listener, never read by one. */
interface AttachedChild {
  readonly child: RuntimeChildProcess;
  readonly exited: Deferred.Deferred<ExitFacts>;
  readonly processError: Deferred.Deferred<Error>;
  readonly readyUrl: Deferred.Deferred<string, RuntimeLifecycleFailure>;
  /** Flushes partial log lines and removes the listeners. Idempotent. */
  readonly release: () => void;
}

const make = Effect.gen(function* () {
  const config = yield* RuntimeProcessConfig;
  const layerScope = yield* Effect.scope;
  const status = yield* SubscriptionRef.make<HostRuntimeStatusSnapshot>({
    protocolVersion: HOST_RUNTIME_STATUS_PROTOCOL_VERSION,
    revision: 0,
    ownership: config.target.ownership,
    state: 'connecting',
  });
  // Snapshot publication and the revision increment are one atomic transition.
  const publish = (facts: SnapshotFacts) =>
    SubscriptionRef.update(
      status,
      (current) =>
        ({
          ...facts,
          protocolVersion: HOST_RUNTIME_STATUS_PROTOCOL_VERSION,
          revision: current.revision + 1,
        }) as HostRuntimeStatusSnapshot,
    );

  /** The one outcome every `start`/`url` caller waits for: the URL once usable, or the stored terminal failure. */
  const ready = yield* Deferred.make<string, RuntimeLifecycleFailure>();
  const stopped = yield* Deferred.make<void>();
  // Every read-modify-write of `phase` happens without a yield in between (single-threaded JS).
  let phase: 'idle' | 'started' | 'stopping' | 'stopped' = 'idle';
  let run: Fiber.Fiber<void> | undefined;
  /** Set once startup or the running child failed; `ready` may already hold the URL when a ready runtime crashes. */
  let terminalFailure: RuntimeLifecycleFailure | undefined;

  const log = (stream: RuntimeLogStream, payload: string) => config.log({ stream, payload });
  const forward = (stream: RuntimeLogStream, line: DecodedLine) =>
    log(stream, `${line.payload}${line.ending}`);

  /** A signal that cannot be delivered is logged, not raised: termination must always finish. */
  const signal = (child: RuntimeChildProcess, name: NodeJS.Signals) => {
    try {
      config.adapter.signal(child, name);
      return true;
    } catch (error) {
      log('stderr', `Failed to signal managed runtime with ${name}: ${errorMessage(error)}\n`);
      return false;
    }
  };

  /**
   * Edge adapter: the only place Node's child-process callbacks are registered. Scoped: `terminate` is registered as
   * soon as the child exists, before any listener is attached, so a throw while attaching (a defect the run reports as
   * `process_error`) still signals the child when the run's scope closes. Uninterruptible like an `acquireRelease`
   * acquire, so a stop cannot land between creating the child and registering its termination.
   */
  const spawn = (specification: RuntimeSpawnSpecification) =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ExitFacts>();
      const processError = yield* Deferred.make<Error>();
      const readyUrl = yield* Deferred.make<string, RuntimeLifecycleFailure>();
      const child = yield* Effect.try({
        try: () => config.adapter.spawn(specification),
        catch: (error) => failure('spawn_failed', { message: errorMessage(error) }),
      });
      const stdout = new LosslessLineDecoder();
      const stderr = new LosslessLineDecoder();
      /** Removes exactly the listeners that were attached, so a partial attachment releases cleanly. */
      const detach: Array<() => void> = [];
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        for (const line of stdout.end()) forward('stdout', line);
        for (const line of stderr.end()) forward('stderr', line);
        for (const remove of detach.splice(0)) remove();
      };
      const attached: AttachedChild = { child, exited, processError, readyUrl, release };
      yield* Effect.addFinalizer(() => terminate(attached));

      // Releasing before completing `exited` keeps the final partial lines ahead of whatever the exit causes.
      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        release();
        Deferred.doneUnsafe(exited, Effect.succeed({ code, signal: exitSignal }));
      };
      const onError = (error: Error) => {
        Deferred.doneUnsafe(processError, Effect.succeed(error));
      };
      const onStdout = (chunk: Buffer) => {
        for (const line of stdout.write(chunk)) {
          forward('stdout', line);
          observeReadyLine(readyUrl, line.payload);
        }
      };
      const onStderr = (chunk: Buffer) => {
        for (const line of stderr.write(chunk)) forward('stderr', line);
      };
      // `exit` first: once it is attached, `terminate` observes the exit even if a later attachment throws.
      yield* Effect.sync(() => {
        child.once('exit', onExit);
        detach.push(() => child.off('exit', onExit));
        child.once('error', onError);
        detach.push(() => child.off('error', onError));
        child.stdout.on('data', onStdout);
        detach.push(() => child.stdout.off('data', onStdout));
        child.stderr.on('data', onStderr);
        detach.push(() => child.stderr.off('data', onStderr));
      });
      return attached;
    }).pipe(Effect.uninterruptible);

  /**
   * The configured health check, with anything it throws (a defect, or a synchronous throw from building the check)
   * reported as a failed check: whatever goes wrong there must settle `start`, never leave it waiting.
   */
  const checkHealth = (url: string) =>
    Effect.suspend(() => config.checkHealth(url)).pipe(
      Effect.catchDefect((defect) => Effect.fail(toError(defect))),
    );

  /** `SIGTERM`, the grace period, `SIGKILL`, one more second, then stop watching. Never fails. */
  const terminate = (attached: AttachedChild) =>
    Effect.gen(function* () {
      if (yield* Deferred.isDone(attached.exited)) return;
      signal(attached.child, 'SIGTERM');
      if (yield* exitsWithin(attached, config.stopGrace)) return;
      if (!signal(attached.child, 'SIGKILL')) return;
      if (yield* exitsWithin(attached, killObservationWindow)) return;
      log('stderr', 'Managed runtime did not report exit after SIGKILL; abandoning observation.\n');
      attached.release();
    });

  const runManaged = (prepare: Effect.Effect<RuntimeSpawnSpecification, RuntimeLifecycleFailure>) =>
    Effect.gen(function* () {
      const specification = yield* prepare.pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(failure('stage_invalid', { message: errorMessage(defect) })),
        ),
      );
      const attached = yield* spawn(specification);

      // Until the runtime is ready, an exit or a process error ends startup.
      const exitBeforeReady = Deferred.await(attached.exited).pipe(
        Effect.flatMap(({ code, signal: exitSignal }) =>
          Effect.fail(
            failure('exited_before_ready', {
              message: 'Runtime exited before becoming ready.',
              exitCode: code,
              signal: exitSignal,
            }),
          ),
        ),
      );
      const errorBeforeReady = Deferred.await(attached.processError).pipe(
        Effect.flatMap((error) => Effect.fail(failure('spawn_failed', { message: error.message }))),
      );

      const url = yield* Deferred.await(attached.readyUrl).pipe(
        Effect.raceFirst(exitBeforeReady),
        Effect.raceFirst(errorBeforeReady),
        Effect.timeoutOrElse({
          duration: config.readinessTimeout,
          orElse: () =>
            Effect.fail(
              failure('readiness_timeout', {
                message: `Runtime did not report readiness within ${Duration.toMillis(config.readinessTimeout)}ms.`,
              }),
            ),
        }),
      );
      yield* checkHealth(url).pipe(
        Effect.mapError((error) => failure('health_check_failed', { message: error.message })),
        Effect.raceFirst(exitBeforeReady),
        Effect.raceFirst(errorBeforeReady),
      );
      yield* publish({ ownership: 'managed', state: 'ready' });
      yield* Deferred.succeed(ready, url);

      // Running: the next exit or process error is a failure.
      return yield* Deferred.await(attached.exited).pipe(
        Effect.flatMap(({ code, signal: exitSignal }) =>
          Effect.fail(
            failure('exited_after_ready', {
              message: 'Runtime exited after becoming ready.',
              exitCode: code,
              signal: exitSignal,
            }),
          ),
        ),
        Effect.raceFirst(
          Deferred.await(attached.processError).pipe(
            Effect.flatMap((error) =>
              Effect.fail(failure('process_error', { message: error.message })),
            ),
          ),
        ),
      );
    }).pipe(
      // A defect anywhere above is still a terminal failure: it is published and settles every waiter.
      Effect.catchDefect((defect) =>
        Effect.fail(failure('process_error', { message: errorMessage(defect) })),
      ),
      // Inside the scope, so the failure is published and every waiter settled before `terminate` runs. One
      // uninterruptible step: a concurrent stop cannot leave the failure stored but unpublished.
      Effect.catch((lifecycleFailure) =>
        Effect.suspend(() => {
          terminalFailure = lifecycleFailure;
          return publish({
            ownership: 'managed',
            state: 'failed',
            reason: lifecycleFailure.reason,
            diagnostic: lifecycleFailure.diagnostic,
          }).pipe(Effect.andThen(Deferred.fail(ready, lifecycleFailure)));
        }).pipe(Effect.uninterruptible),
      ),
      Effect.asVoid,
      Effect.scoped,
    );

  const runExternal = (url: string) =>
    checkHealth(url).pipe(
      Effect.matchEffect({
        onSuccess: () => publish({ ownership: 'external', state: 'ready' }),
        onFailure: (error) =>
          publish(externalUnreachable).pipe(
            Effect.andThen(
              Effect.sync(() =>
                log('stderr', `[external] health check failed: ${errorMessageWithoutUrl(error)}\n`),
              ),
            ),
          ),
      }),
      // An unreachable external runtime still loads through: its URL is handed out either way.
      Effect.andThen(Deferred.succeed(ready, url)),
      Effect.asVoid,
    );

  /**
   * The lifecycle invariant, held for every way the run fiber can end: unless a stop interrupted it, an exit that has
   * not already published a terminal outcome publishes one and settles `ready`. The paths above do this themselves
   * (a managed failure inside the run's scope, before `terminate`); this is the backstop for whatever escapes them, so
   * a defect in `prepare`, `checkHealth`, `publish`, the log sink or a finalizer can never leave `start` waiting.
   */
  const settleRunExit = (target: RuntimeTarget, exit: Exit.Exit<void>) =>
    Effect.suspend(() => {
      if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
      // Interrupted by a stop or by the layer scope closing, with a defect alongside (a failing finalizer): the stop
      // owns the outcome, so the defect is only logged.
      const stopping = phase !== 'started' || Cause.hasInterrupts(exit.cause);
      const defect = Cause.squash(exit.cause);
      if (target.ownership === 'external') {
        // Logged and reported like a failed health check, without the message: it could carry the external URL.
        const logged = Effect.logError(
          `External runtime supervision ended unexpectedly: ${errorMessageWithoutUrl(defect)}`,
        );
        // An external runtime whose outcome is already known loads through as it is.
        if (stopping || Deferred.isDoneUnsafe(ready)) return logged;
        return logged.pipe(
          Effect.andThen(publish(externalUnreachable)),
          Effect.andThen(Deferred.succeed(ready, target.url)),
        );
      }
      const logged = Effect.logError('Managed runtime supervision ended unexpectedly', exit.cause);
      // A stored failure has already been published and has settled `ready`.
      if (stopping || terminalFailure) return logged;
      const lifecycleFailure = failure('process_error', { message: errorMessage(defect) });
      terminalFailure = lifecycleFailure;
      return logged.pipe(
        Effect.andThen(
          publish({
            ownership: 'managed',
            state: 'failed',
            reason: lifecycleFailure.reason,
            diagnostic: lifecycleFailure.diagnostic,
          }),
        ),
        Effect.andThen(Deferred.fail(ready, lifecycleFailure)),
      );
    });

  const start = Effect.gen(function* () {
    if (phase === 'stopping' || phase === 'stopped') return yield* stoppingFailure();
    if (terminalFailure) return yield* terminalFailure;
    if (phase === 'idle') {
      phase = 'started';
      const target = config.target;
      // Forked into the layer scope, not the caller's: a caller that stops waiting (an IPC invoke torn down with its
      // window) must not cancel the runtime everyone else waits on. Suspended, so even building the run happens inside
      // the fiber whose exit `settleRunExit` observes.
      run = yield* Effect.forkIn(
        Effect.suspend(() =>
          target.ownership === 'managed' ? runManaged(target.prepare) : runExternal(target.url),
        ).pipe(Effect.onExit((exit) => settleRunExit(target, exit))),
        layerScope,
      );
    }
    yield* Deferred.await(ready);
  }).pipe(Effect.withSpan('RuntimeProcess.start'));

  const stop = Effect.gen(function* () {
    if (phase === 'stopping' || phase === 'stopped') return yield* Deferred.await(stopped);
    phase = 'stopping';
    // Settles pending `start`/`url` callers; a no-op once the outcome is known.
    yield* Deferred.fail(ready, stoppingFailure());
    // Interrupting the run closes its scope, which runs `terminate`. An interrupted run publishes nothing, so an
    // intentional stop is never reported as a failure.
    if (run) yield* Fiber.interrupt(run);
    phase = 'stopped';
    yield* Deferred.succeed(stopped, undefined);
  }).pipe(Effect.uninterruptible, Effect.withSpan('RuntimeProcess.stop'));

  yield* Effect.addFinalizer(() => stop);

  return RuntimeProcess.of({
    status,
    start,
    url:
      config.target.ownership === 'external'
        ? Effect.succeed(config.target.url)
        : start.pipe(Effect.andThen(Deferred.await(ready))),
    stop,
  });
});

export class RuntimeProcess extends Context.Service<
  RuntimeProcess,
  {
    /** The current snapshot and every later one. */
    readonly status: SubscriptionRef.SubscriptionRef<HostRuntimeStatusSnapshot>;
    /** Idempotent and shared: the first call spawns (or health-checks an external runtime); every caller waits for the same outcome. */
    readonly start: Effect.Effect<void, RuntimeLifecycleFailure>;
    /** The runtime URL: an external one immediately, a managed one once it is ready. */
    readonly url: Effect.Effect<string, RuntimeLifecycleFailure>;
    /** Idempotent; later callers wait for the first. Also the layer's finalizer, so disposing the runtime stops the child. */
    readonly stop: Effect.Effect<void>;
  }
>()('isagi/desktop/runtime-process/RuntimeProcess') {
  static readonly layer: Layer.Layer<RuntimeProcess, never, RuntimeProcessConfig> = Layer.effect(
    RuntimeProcess,
    make,
  );
}

/** Completes `readyUrl` from the first ready line; later ready lines and every other line are ignored. */
function observeReadyLine(
  readyUrl: Deferred.Deferred<string, RuntimeLifecycleFailure>,
  line: string,
) {
  if (!line.startsWith(readyPrefix) || Deferred.isDoneUnsafe(readyUrl)) return;
  try {
    const payload = JSON.parse(line.slice(readyPrefix.length)) as { readonly url?: unknown };
    if (typeof payload.url !== 'string') throw new Error('readiness payload has no string URL');
    Deferred.doneUnsafe(readyUrl, Effect.succeed(validateManagedRuntimeUrl(payload.url)));
  } catch (error) {
    Deferred.doneUnsafe(
      readyUrl,
      Effect.fail(failure('readiness_malformed', { message: errorMessage(error) })),
    );
  }
}

const externalUnreachable = {
  ownership: 'external',
  state: 'unreachable',
  reason: 'external_health_check_failed',
  diagnostic: { message: 'The configured external runtime did not pass its health check.' },
} as const satisfies SnapshotFacts;

function exitsWithin(attached: AttachedChild, duration: Duration.Duration) {
  return Deferred.await(attached.exited).pipe(
    Effect.timeoutOption(duration),
    Effect.map(Option.isSome),
  );
}

function failure(reason: ManagedFailureReason, diagnostic: HostRuntimeDiagnostic) {
  return new RuntimeLifecycleFailure({ reason, diagnostic });
}

function stoppingFailure() {
  return failure('process_error', { message: 'Runtime lifecycle is stopping or stopped.' });
}

// The port must be written out. It is matched on the reported text because `URL` normalizes the
// default port away (`http://127.0.0.1:80` has an empty `url.port`), and port 80 is a valid choice.
const explicitLoopbackPort = /^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/u;

function validateManagedRuntimeUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !explicitLoopbackPort.test(value)
  ) {
    throw new Error(
      `Managed runtime readiness URL must use http://127.0.0.1:<port>; got ${value}. Set server.host (or ISAGI_HOST) to 127.0.0.1 or 0.0.0.0 for a desktop-managed runtime.`,
    );
  }
  return url.toString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessageWithoutUrl(error: unknown) {
  if (!(error instanceof Error)) return 'health request failed';
  if (URL.canParse(error.message)) return 'health request failed';
  return error.message.replace(/https?:\/\/\S+/g, '<external-runtime>');
}
