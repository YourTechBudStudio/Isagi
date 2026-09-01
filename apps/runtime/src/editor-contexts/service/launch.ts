import { randomBytes } from 'node:crypto';

import { Effect } from 'effect';

import type { EditorAttemptFailureReason } from '@isagi/contracts';

import { describeOperationalCause } from '../../diagnostics/operational-cause.js';
import type { ResolvedEditorInstallation } from '../../editor-provisioning/index.js';
import type { LoopbackPortProbeService } from '../../lib/net/loopback-port-probe.js';
import type { DatabaseError } from '../../persistence/index.js';
import type { PtyService } from '../../pty-processes/index.js';
import type { WorkspaceRepositoryService } from '../../workspace/index.js';
import type { EditorContextRepositoryService } from '../editor-contexts.repository.js';
import { EditorError, EditorLaunchFailed } from '../errors.js';
import {
  editorLaunchSpec,
  editorLoopbackHost,
  editorSessionSocketPath,
  maxSessionSocketPathBytes,
} from '../launch-spec.js';
import type { EditorContextRow } from '../types.js';

/**
 * What the launch may do to the service's own state, expressed as three narrow
 * capabilities rather than as the state itself.
 *
 * The service keeps the readiness map, the probe fibers, the registration gate,
 * and the probe implementation. Handing them over would make this module a
 * co-owner of runtime state it does not supervise and cannot clean up, and the
 * file split would then be a relocation rather than a boundary. What this module
 * genuinely owns is the interruption-sensitive ordering below.
 */
export interface EditorLaunchCapabilities {
  /**
   * Persist a Class B failure and publish it. Returns whether it committed;
   * `context_missing` means the durable context is gone and there is nothing
   * left to record against.
   */
  readonly commitAttemptFailure: (input: {
    readonly editorContextId: number;
    readonly reason: EditorAttemptFailureReason;
    readonly detail: string | null;
  }) => Effect.Effect<'applied' | 'context_missing', DatabaseError>;
  readonly publishChanged: (editorContextId: number) => Effect.Effect<void>;
  /**
   * Seed the pending observation and fork the probe, returning only once the
   * fiber is registered.
   */
  readonly registerProbe: (input: {
    readonly editorContextId: number;
    readonly ptyProcessId: number;
    readonly host: string;
    readonly port: number;
  }) => Effect.Effect<void>;
}

export interface EditorLaunchDependencies extends EditorLaunchCapabilities {
  readonly repository: EditorContextRepositoryService;
  readonly workspace: WorkspaceRepositoryService;
  readonly pty: PtyService;
  readonly portProbe: LoopbackPortProbeService;
}

/**
 * Start one Code Server incarnation for a context whose attempt is already
 * `in_progress`.
 *
 * The whole file exists for the ordering below, which has to satisfy three
 * properties that pull against each other:
 *
 *  - there is never a window in which the PTY allocation is neither started nor
 *    abandoned;
 *  - the spawn itself stays cancellable, because the PTY layer already puts
 *    pre-spawn preparation and the backend spawn inside its own restore regions
 *    with their own cleanup, and a blanket uninterruptible region here would
 *    neutralize them and make a cancelled request wait for a spawn;
 *  - the probe fiber stays interruptible, because supersession, terminal PTY
 *    events, and scope shutdown all end it by interruption, and a fiber forked
 *    inside an uninterruptible region inherits that flag and would ignore all
 *    three.
 *
 * Hence one explicit mask with `restore` at exactly two points rather than a
 * blanket `uninterruptible`.
 */
export function launchEditorIncarnation(input: {
  readonly deps: EditorLaunchDependencies;
  readonly row: EditorContextRow;
  readonly installation: ResolvedEditorInstallation;
}): Effect.Effect<void, DatabaseError | EditorError | EditorLaunchFailed> {
  const { deps, row, installation } = input;

  // Persist, then raise, always in that order and never one without the other:
  // the row carries the reason for every future reader and the error carries it
  // to the caller that asked. A write that converged away has no row to report
  // against, so it reports the truth instead.
  const fail = (
    reason: EditorAttemptFailureReason,
    detail: string | null,
  ): Effect.Effect<never, DatabaseError | EditorError | EditorLaunchFailed> =>
    deps.commitAttemptFailure({ editorContextId: row.id, reason, detail }).pipe(
      Effect.flatMap((outcome) =>
        Effect.fail(
          outcome === 'applied'
            ? new EditorLaunchFailed({
                editorContextId: row.id,
                reason,
                detail,
              })
            : missingContext(row.id),
        ),
      ),
    );

  const prepare = Effect.gen(function* () {
    // Re-read rather than trusting a path captured earlier: a worktree can be
    // moved or removed between placement and launch, and the process must open
    // the checkout that exists now.
    const worktree = yield* deps.workspace.findWorktree(row.worktreeId);
    if (!worktree) return yield* fail('launch_target_missing', null);

    const port = yield* deps.portProbe.obtainEphemeralPort.pipe(
      Effect.catchTag('LoopbackPortUnavailable', (error) =>
        fail('port_allocation_failed', describeOperationalCause(error.cause)),
      ),
    );

    const socketPath = editorSessionSocketPath(
      installation.sessionSocketDirectory,
      row.id,
      randomBytes(3).toString('hex'),
    );
    if (Buffer.byteLength(socketPath) > maxSessionSocketPathBytes) {
      // Refused before anything is allocated: the platform would reject the
      // bind, and a spawn that is certain to fail is not worth a process row.
      return yield* fail(
        'session_socket_unavailable',
        `session socket path exceeds ${maxSessionSocketPathBytes} bytes`,
      );
    }

    const spec = editorLaunchSpec({
      installation,
      worktreePath: worktree.path,
      port,
      socketPath,
    });
    return { cwd: worktree.path, port, socketPath, spec };
  }).pipe(
    // Nothing is allocated yet, so an interruption here has exactly one durable
    // consequence to record: the attempt never happened. Without this the row
    // would stay `in_progress` for the rest of the runtime's life, with the pane
    // stuck on "launching" and the settled-state affordance refusing to act.
    Effect.onInterrupt(() => commitInterruptedAttempt(deps, row.id)),
  );

  return Effect.gen(function* () {
    const prepared = yield* prepare;

    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // The A-guarantee. `abandon` is idempotent and a no-op once `start` has
        // begun, so attaching it as a scoped release is safe unconditionally: an
        // interruption after the handoff but before the spawn marks the row
        // failed and releases the reservation, rather than leaking a row that is
        // reserved forever.
        const allocation = yield* Effect.acquireRelease(
          deps.pty.allocateLaunch({
            command: prepared.spec.command,
            args: prepared.spec.args,
            cwd: prepared.cwd,
            launchMode: 'direct',
            // Never the configured backend. A tmux incarnation would retain no
            // startup output for diagnostics and would survive a runtime restart
            // holding its port and socket — a live process this runtime does not
            // own, which is exactly the hazard the lifecycle is built to avoid.
            backend: 'node_pty',
          }),
          (acquired) => acquired.abandon,
        ).pipe(
          Effect.catchAll((error) =>
            fail('launch_allocation_failed', describeOperationalCause(error)),
          ),
        );

        // Ownership commits *before* the process starts. This is one step
        // stronger than the command launcher, which installs its pointer after
        // starting and therefore needs an interruption finalizer to adopt an
        // already-running process. Here no process can exist without an owner.
        const installed = yield* deps.repository
          .installIncarnation({
            editorContextId: row.id,
            handoff: {
              ptyProcessId: allocation.ptyProcessId,
              endpointHost: editorLoopbackHost,
              endpointPort: prepared.port,
              sessionSocketPath: prepared.socketPath,
            },
          })
          .pipe(
            Effect.catchTag('DatabaseError', (error) =>
              fail('launch_allocation_failed', describeOperationalCause(error)),
            ),
          );
        if (installed === 'context_missing') return yield* Effect.fail(missingContext(row.id));
        yield* deps.publishChanged(row.id);

        // Registered before `start`, not after: `start` can publish a launch
        // failure, and a process that dies immediately can publish an exit,
        // before a post-start registration would have run. Registering first is
        // what makes the terminal-event lifecycle total — every terminal event
        // that can be published already has an entry and a fiber to end.
        yield* restore(
          deps.registerProbe({
            editorContextId: row.id,
            ptyProcessId: allocation.ptyProcessId,
            host: editorLoopbackHost,
            port: prepared.port,
          }),
        );

        // Restored flags: the PTY layer's own cancellation semantics apply, so a
        // cancelled request does not wait on a spawn.
        yield* restore(allocation.start);
      }).pipe(Effect.scoped),
    );

    // The process transitioned; a client that did not make this request learns
    // of it here rather than by polling.
    yield* deps.publishChanged(row.id);
  });
}

/**
 * Record an interrupted attempt without raising.
 *
 * `onInterrupt` requires a `never` error channel, so the database failure has to
 * be resolved here — but it cannot be resolved by pretending the cancellation
 * was clean. If this write fails, the row stays `in_progress` for the rest of
 * this runtime's life, which is precisely the state the launch sequence exists
 * to prevent; reporting that as an ordinary cancellation would hide it. So it
 * logs one safe, authored line and then dies.
 *
 * There is deliberately no retry. A same-runtime repair queue is a separate
 * lifecycle mechanism, and boot convergence already repairs the row on the next
 * construction.
 */
function commitInterruptedAttempt(deps: EditorLaunchCapabilities, editorContextId: number) {
  return deps
    .commitAttemptFailure({
      editorContextId,
      reason: 'launch_interrupted',
      detail: null,
    })
    .pipe(
      Effect.catchTag('DatabaseError', (error) =>
        Effect.logWarning(
          `[runtime] editor launch interruption could not be recorded editorContextId=${editorContextId} cause=${describeOperationalCause(error)}`,
        ).pipe(
          Effect.zipRight(
            // Never the error object itself: a later cause renderer could reach
            // its foreign cause.
            Effect.dieMessage(
              `Editor context ${editorContextId} could not record an interrupted launch attempt.`,
            ),
          ),
        ),
      ),
      Effect.asVoid,
    );
}

/**
 * The context vanished mid-launch — a worktree deletion cascading it away.
 *
 * Nothing committed, so nothing is published, and the caller is told what is
 * actually true rather than being handed a launch failure with no row to sit on.
 */
function missingContext(editorContextId: number) {
  return new EditorError({
    code: 'editor_context_not_found',
    message: `Editor context ${editorContextId} no longer exists.`,
    editorContextId,
  });
}
