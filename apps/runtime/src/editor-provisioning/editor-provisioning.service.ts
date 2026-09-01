import process from 'node:process';

import { Context, Data, Duration, Effect, Layer, Option, Ref } from 'effect';

import type { EditorProvisioningFailureReason, EditorProvisioningState } from '@isagi/contracts';

import { DataDirectory, type DataDirectoryService } from '../persistence/index.js';
import { EditorInstallIo, type EditorInstallIoService } from './install-io.js';
import {
  provisionCodeServer,
  EditorProvisioningFailure,
  type ResolvedEditorInstallation,
} from './install.js';
import { artifactForPlatform, codeServerManifest, hostEditorPlatformKey } from './manifest.js';

// The capability-aware owner of the pinned Code Server installation.
//
// Three things about its lifecycle are load-bearing and easy to break:
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
//  3. **An undeclared capability is a real answer, not a degraded one.** A
//     runtime that was never told it manages an editor writes nothing, contacts
//     nothing, and reports `not_applicable`.

export class EditorUnavailable extends Data.TaggedError('EditorUnavailable')<{
  readonly reason: 'editor_unsupported_runtime' | 'editor_unavailable';
  readonly diagnostic: string | null;
}> {}

export class EditorProvisioningBusy extends Data.TaggedError('EditorProvisioningBusy')<{}> {}

export interface EditorProvisioningService {
  /** Forked from `startRuntimeServer`, the way `HarnessControlPlane.start`
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
   * `retry` deliberately does not call it: retry asks the domain to report or
   * re-enter its state, and `not_applicable` is a complete answer to that
   * question. Operations that need an installation are the ones that must
   * refuse.
   */
  readonly requireReady: Effect.Effect<ResolvedEditorInstallation, EditorUnavailable>;
}

export const EditorProvisioning = Context.GenericTag<EditorProvisioningService>(
  'isagi/EditorProvisioning',
);

export type EditorCapability = 'code_server' | null;

/**
 * Reads the capability declaration from an environment object.
 *
 * Takes the environment rather than reading `process.env` so it is testable
 * without mutating a process global — which matters more than usual here,
 * because the runtime suite runs every test file in one process.
 */
export function editorCapabilityFromEnvironment(env: {
  readonly ISAGI_EDITOR_CAPABILITY?: string | undefined;
}): EditorCapability {
  return env.ISAGI_EDITOR_CAPABILITY === 'code_server' ? 'code_server' : null;
}

/** Program design §7.1.6. Long enough for a 235 MB artifact on an ordinary
 *  connection; bounded so the attempt always settles. */
export const editorProvisioningDeadline = Duration.minutes(10);

const notApplicable: EditorProvisioningState = { status: 'not_applicable' };

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

export interface EditorProvisioningOptions {
  readonly capability: EditorCapability;
  readonly deadline?: Duration.DurationInput;
}

/**
 * The scoped implementation, with the capability passed in.
 *
 * `EditorProvisioningLive` is the production binding that resolves the
 * capability from the environment exactly once, at layer acquisition; tests
 * drive this with an explicit value instead.
 */
export function makeEditorProvisioning(options: EditorProvisioningOptions) {
  return Effect.gen(function* () {
    const directory = yield* DataDirectory;
    const io = yield* EditorInstallIo;
    const scope = yield* Effect.scope;
    const deadline = Duration.decode(options.deadline ?? editorProvisioningDeadline);

    if (options.capability === null) return notApplicableService;

    const version = codeServerManifest.version;
    const phase = yield* Ref.make<EditorProvisioningPhase>({
      kind: 'transient',
      status: 'checking',
    });
    const setTransient = (status: 'checking' | 'downloading' | 'verifying' | 'extracting') =>
      Ref.set(phase, { kind: 'transient', status });
    const attempt = yield* Effect.makeSemaphore(1);
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
        Effect.timeoutFail({
          duration: deadline,
          onTimeout: () =>
            new EditorProvisioningFailure({
              reason: 'download_failed',
              diagnostic: `Provisioning Code Server ${version} timed out after ${Duration.format(deadline)}.`,
            }),
        }),
        Effect.either,
      );

      if (result._tag === 'Left') {
        return yield* settleFailed({
          reason: result.left.reason,
          diagnostic: result.left.diagnostic,
        });
      }
      yield* Ref.set(phase, { kind: 'ready', installation: result.right });
      return { status: 'ready', version } satisfies EditorProvisioningState;
    }).pipe(
      // Modelled failures and the deadline settle through `Effect.either` above,
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

    return {
      start: Ref.getAndSet(attemptRequested, true).pipe(
        Effect.flatMap((alreadyRequested) =>
          alreadyRequested
            ? Effect.void
            : Effect.forkIn(attempt.withPermits(1)(runAttempt), scope).pipe(Effect.asVoid),
        ),
      ),
      state: Effect.map(Ref.get(phase), (current) => projectPhase(current, version)),
      retry: Effect.zipRight(
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
      ),
      requireReady: Effect.gen(function* () {
        const current = yield* Ref.get(phase);
        if (current.kind === 'ready') return current.installation;
        return yield* new EditorUnavailable({
          reason: 'editor_unavailable',
          diagnostic: current.kind === 'failed' ? current.diagnostic : null,
        });
      }),
    } satisfies EditorProvisioningService;
  });
}

/**
 * An undeclared runtime. Every method is a complete answer rather than a
 * disabled one: nothing is written under `tools/` or `editors/`, no request is
 * made, and `requireReady` says honestly that this runtime is not the kind that
 * has an editor.
 */
const notApplicableService: EditorProvisioningService = {
  start: Effect.void,
  state: Effect.succeed(notApplicable),
  retry: Effect.succeed(notApplicable),
  requireReady: Effect.fail(
    new EditorUnavailable({ reason: 'editor_unsupported_runtime', diagnostic: null }),
  ),
};

export const EditorProvisioningLive: Layer.Layer<
  EditorProvisioningService,
  never,
  DataDirectoryService | EditorInstallIoService
> = Layer.scoped(
  EditorProvisioning,
  Effect.suspend(() =>
    // Read once, at layer acquisition. Everything below this line takes the
    // capability as a value.
    makeEditorProvisioning({ capability: editorCapabilityFromEnvironment(process.env) }),
  ),
);
