import { Context, Data, Duration, Effect, Layer, Option, Ref, Semaphore } from 'effect';

import type { EditorProvisioningFailureReason, EditorProvisioningState } from '@isagi/contracts';

import { DataDirectory } from '../../platform/persistence/index.js';
import { EditorInstallIo } from './install-io.js';
import {
  provisionCodeServer,
  EditorProvisioningFailure,
  type ResolvedEditorInstallation,
} from './install.js';
import { artifactForPlatform, codeServerManifest, hostEditorPlatformKey } from './manifest.js';

// The owner of the pinned Code Server installation. Every runtime provisions it:
// `start` begins the attempt at boot, and only an in-process test that injects
// `startAtBoot: false` skips that (a user `retry` still provisions there).
//
// Two things about its lifecycle are load-bearing and easy to break:
//
//  1. **Layer construction performs no IO and never blocks on readiness.** The
//     host's runtime-ready deadline is 15 seconds and its expiry is fatal, while
//     the pinned artifacts are 200–235 MB. Provisioning is therefore a forked
//     background attempt whose state is *queried*, never a construction-time
//     dependency.
//  2. **The attempt always settles.** One bounded deadline, no automatic retry
//     on a timer, and an interruption finalizer so an attempt killed from the
//     outside — an aborted retry request, a scope shutdown — settles as a
//     failure instead of leaving the projection transient forever. A
//     user-initiated `retry` is the only way a settled failure is re-attempted.

export class EditorUnavailable extends Data.TaggedError('EditorUnavailable')<{
  readonly reason: 'editor_unavailable';
  readonly diagnostic: string | null;
}> {}

export class EditorProvisioningBusy extends Data.TaggedError('EditorProvisioningBusy')<{}> {}

/** Long enough for a 235 MB artifact on an ordinary
 *  connection; bounded so the attempt always settles. */
export const editorProvisioningDeadline = Duration.minutes(10);

/**
 * Provisioning's inputs, read once at layer acquisition. Production uses the defaults; tests provide
 * `Layer.succeed(EditorProvisioningSettings, {...})`, with `startAtBoot: false` for in-process runtime boots and, for
 * the deadline tests, a short deadline.
 */
export const EditorProvisioningSettings = Context.Reference<{
  readonly deadline: Duration.Duration;
  /** Whether `start` begins the boot attempt. In-process runtime tests set false so nothing downloads; `retry` still works. */
  readonly startAtBoot: boolean;
}>('isagi/runtime/editor/EditorProvisioningSettings', {
  defaultValue: () => ({ deadline: editorProvisioningDeadline, startAtBoot: true }),
});

/**
 * The single internal fact this service owns.
 *
 * The projected {@link EditorProvisioningState} and the resolved installation
 * are two *views* of this one value rather than two `Ref`s that can disagree:
 * only the `ready` variant carries an installation, so a transient or failed
 * phase cannot hand one out, and a retry that moves back to `checking`
 * necessarily withdraws readiness in the same atomic write.
 */
type EditorProvisioningPhase =
  | {
      readonly kind: 'transient';
      readonly status: 'checking' | 'downloading' | 'verifying' | 'extracting';
    }
  | { readonly kind: 'ready'; readonly installation: ResolvedEditorInstallation }
  | {
      readonly kind: 'failed';
      readonly reason: EditorProvisioningFailureReason;
      readonly diagnostic: string | null;
    };

function projectPhase(phase: EditorProvisioningPhase, version: string): EditorProvisioningState {
  switch (phase.kind) {
    case 'transient':
      return { status: phase.status, version };
    case 'ready':
      return { status: 'ready', version };
    case 'failed':
      return { status: 'failed', version, reason: phase.reason, diagnostic: phase.diagnostic };
  }
}

/** The scoped implementation. Its settings are read exactly once, at layer acquisition. */
const make = Effect.gen(function* () {
  const directory = yield* DataDirectory;
  const io = yield* EditorInstallIo;
  const scope = yield* Effect.scope;
  const settings = yield* EditorProvisioningSettings;
  const deadline = settings.deadline;

  const version = codeServerManifest.version;
  const phase = yield* Ref.make<EditorProvisioningPhase>({
    kind: 'transient',
    status: 'checking',
  });
  const setTransient = (status: 'checking' | 'downloading' | 'verifying' | 'extracting') =>
    Ref.set(phase, { kind: 'transient', status });
  const attempt = yield* Semaphore.make(1);
  const attemptRequested = yield* Ref.make(false);

  const settleFailed = (input: {
    readonly reason: EditorProvisioningFailureReason;
    readonly diagnostic: string | null;
  }) =>
    // One write, so a failed attempt cannot leave a stale installation behind
    // for `requireReady` to hand out.
    Ref.set(phase, { kind: 'failed', reason: input.reason, diagnostic: input.diagnostic }).pipe(
      Effect.as({
        status: 'failed',
        version,
        reason: input.reason,
        diagnostic: input.diagnostic,
      } satisfies EditorProvisioningState),
    );

  const runAttempt: Effect.Effect<EditorProvisioningState> = Effect.gen(function* () {
    const platformKey = hostEditorPlatformKey();
    if (platformKey === null) {
      return yield* settleFailed({
        reason: 'unsupported_platform',
        diagnostic: 'Isagi does not ship a Code Server build for this platform.',
      });
    }

    yield* setTransient('checking');
    const result = yield* provisionCodeServer({
      io,
      paths: { toolsPath: directory.paths.toolsPath, editorsPath: directory.paths.editorsPath },
      artifact: artifactForPlatform(codeServerManifest, platformKey),
      platformKey,
      version,
      onPhase: setTransient,
    }).pipe(
      // The deadline interrupts the attempt, which aborts the in-flight
      // request and runs the staging finalizer. It is reported as a download
      // failure because that is the stage a long attempt overwhelmingly
      // expires in, and the diagnostic says "timed out" rather than implying a
      // transport fault.
      Effect.timeoutOrElse({
        duration: deadline,
        orElse: () =>
          Effect.fail(
            new EditorProvisioningFailure({
              reason: 'download_failed',
              diagnostic: `Provisioning Code Server ${version} timed out after ${Duration.format(deadline)}.`,
            }),
          ),
      }),
      Effect.result,
    );

    if (result._tag === 'Failure') {
      return yield* settleFailed({
        reason: result.failure.reason,
        diagnostic: result.failure.diagnostic,
      });
    }
    yield* Ref.set(phase, { kind: 'ready', installation: result.success });
    return { status: 'ready', version } satisfies EditorProvisioningState;
  }).pipe(
    // Modelled failures and the deadline settle through `Effect.result` above,
    // but external interruption bypasses it entirely: the retry route runs the
    // attempt under the HTTP request's abort signal, so a client that
    // disconnects mid-download would otherwise leave the projection stuck in a
    // transient state that no poller can ever see settle. The finalizer runs
    // before interruption continues to propagate, so scope shutdown still
    // tears the fiber down.
    Effect.onInterrupt(() =>
      settleFailed({
        reason: 'install_unusable',
        diagnostic: `Provisioning Code Server ${version} was interrupted before it finished.`,
      }),
    ),
  );

  return EditorProvisioning.of({
    // With `startAtBoot` off the state stays at its initial `checking` until a retry.
    start: (settings.startAtBoot
      ? Ref.getAndSet(attemptRequested, true).pipe(
          Effect.flatMap((alreadyRequested) =>
            alreadyRequested
              ? Effect.void
              : Effect.forkIn(attempt.withPermits(1)(runAttempt), scope).pipe(Effect.asVoid),
          ),
        )
      : Effect.void
    ).pipe(Effect.withSpan('EditorProvisioning.start')),
    state: Effect.map(Ref.get(phase), (current) => projectPhase(current, version)).pipe(
      Effect.withSpan('EditorProvisioning.state'),
    ),
    retry: Effect.andThen(
      // Marked before the attempt rather than after, so a boot `start` racing a
      // user retry cannot schedule a second attempt behind it.
      Ref.set(attemptRequested, true),
      attempt
        .withPermitsIfAvailable(1)(runAttempt)
        .pipe(
          Effect.flatMap(
            Option.match({
              // Non-blocking on purpose: a queued retry would stack a second
              // 200 MB download behind the first for a button a user can press
              // repeatedly.
              onNone: () => Effect.fail(new EditorProvisioningBusy()),
              onSome: (settled) => Effect.succeed(settled),
            }),
          ),
        ),
    ).pipe(Effect.withSpan('EditorProvisioning.retry')),
    requireReady: Effect.gen(function* () {
      const current = yield* Ref.get(phase);
      if (current.kind === 'ready') return current.installation;
      return yield* new EditorUnavailable({
        reason: 'editor_unavailable',
        diagnostic: current.kind === 'failed' ? current.diagnostic : null,
      });
    }).pipe(Effect.withSpan('EditorProvisioning.requireReady')),
  });
});

export class EditorProvisioning extends Context.Service<
  EditorProvisioning,
  {
    /** Forked from the runtime's `startup`, the way `HarnessControlPlane.start`
     *  forks docs reconciliation. Idempotent, and never fails. */
    readonly start: Effect.Effect<void>;
    readonly state: Effect.Effect<EditorProvisioningState>;
    /** The user-initiated retry. Re-enters the same attempt and returns the
     *  settled state; refuses while one is already running rather than queueing a
     *  second download behind it. */
    readonly retry: Effect.Effect<EditorProvisioningState, EditorProvisioningBusy>;
    /**
     * The guard every editor *operation* calls first.
     *
     * `retry` deliberately does not call it: retry asks the domain to re-enter
     * its attempt, which is exactly what a runtime without an installation
     * needs. Operations that need an installation are the ones that must
     * refuse.
     */
    readonly requireReady: Effect.Effect<ResolvedEditorInstallation, EditorUnavailable>;
  }
>()('isagi/runtime/editor/EditorProvisioning') {
  static readonly layerNoDeps = Layer.effect(EditorProvisioning, make);
  static readonly layer = EditorProvisioning.layerNoDeps.pipe(Layer.provide(EditorInstallIo.layer));
}
