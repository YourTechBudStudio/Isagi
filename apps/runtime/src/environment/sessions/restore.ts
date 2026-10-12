import { Effect, Result } from 'effect';

import type { HarnessAdapterError, HarnessLaunchBlocked } from '../../harnesses/index.js';
import type { DatabaseError } from '../../platform/persistence/index.js';
import type { AgentSessionError, AgentSessionService } from '../agent-sessions/service.js';
import type { SurfaceRepository } from '../surfaces/repository.js';
import type { TerminalSessionError, TerminalSessionService } from '../terminal-sessions/service.js';
import type { PaneSessionBinding } from './types.js';

type RestoreOutcome =
  | { readonly kind: 'reused'; readonly binding: PaneSessionBinding; readonly ptyProcessId: number }
  | {
      readonly kind: 'relaunched';
      readonly binding: PaneSessionBinding;
      readonly ptyProcessId: number;
    }
  | { readonly kind: 'skipped_unrecoverable'; readonly binding: PaneSessionBinding }
  | { readonly kind: 'failed'; readonly binding: PaneSessionBinding };

interface RestoreDependencies {
  readonly repository: Pick<SurfaceRepository['Service'], 'listPaneSessionBindings'>;
  readonly agentSessions: AgentSessionService['Service'];
  readonly terminalSessions: TerminalSessionService['Service'];
}

/** Everything restoring one binding can fail with. */
type RestoreBindingError =
  | DatabaseError
  | AgentSessionError
  | TerminalSessionError
  | HarnessAdapterError
  | HarnessLaunchBlocked;

/**
 * Startup: relaunches (or reuses) the PTY process of every pane-bound agent and terminal session,
 * each in isolation, and logs a summary. Never fails: a binding that cannot be restored is logged
 * and left for the user, and a failed binding discovery skips the restore. Exposed as
 * `SurfaceService.restorePaneBoundSessions`.
 */
export function restorePaneBoundSessions(deps: RestoreDependencies): Effect.Effect<void> {
  return Effect.gen(function* () {
    const bindings = yield* deps.repository.listPaneSessionBindings;

    // Deliberately unbounded: boot restores the small set of sessions the user
    // already had pane-bound before runtime restart.
    const outcomes = yield* Effect.forEach(bindings, (binding) => restoreBinding(deps, binding), {
      concurrency: 'unbounded',
    });

    yield* Effect.logInfo('Completed pane-bound session restore').pipe(
      Effect.annotateLogs(summarize(outcomes)),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning('Skipped: binding discovery failed').pipe(
        Effect.annotateLogs({
          errorTag: error._tag,
          errorCode: null,
          message: error.message,
        }),
      ),
    ),
    Effect.annotateLogs({ component: 'startup-restore' }),
  );
}

function restoreBinding(
  deps: RestoreDependencies,
  binding: PaneSessionBinding,
): Effect.Effect<RestoreOutcome> {
  const restore: Effect.Effect<number, RestoreBindingError> =
    binding.sessionKind === 'agent_session'
      ? deps.agentSessions.ensureActivePtyProcess(binding.sessionId, {
          replaceEphemeralProcess: true,
        })
      : deps.terminalSessions.ensureActivePtyProcess(binding.sessionId, {
          replaceEphemeralProcess: true,
        });
  return Effect.gen(function* () {
    const result = yield* Effect.result(restore);
    if (Result.isSuccess(result)) {
      const ptyProcessId = result.success;
      return ptyProcessId === binding.activePtyProcessId
        ? ({ kind: 'reused', binding, ptyProcessId } satisfies RestoreOutcome)
        : ({ kind: 'relaunched', binding, ptyProcessId } satisfies RestoreOutcome);
    }

    const error = result.failure;
    const kind = unrecoverableMetadataError(error) ? 'skipped_unrecoverable' : 'failed';
    yield* Effect.logWarning('Failed for pane-bound session').pipe(
      Effect.annotateLogs({
        ...bindingDiagnostic(binding),
        outcome: kind,
        ...failureDiagnostic(error),
      }),
    );
    return { kind, binding } satisfies RestoreOutcome;
  });
}

function summarize(outcomes: readonly RestoreOutcome[]) {
  return {
    attempted: outcomes.length,
    relaunched: outcomes.filter((outcome) => outcome.kind === 'relaunched').length,
    reused: outcomes.filter((outcome) => outcome.kind === 'reused').length,
    skippedUnrecoverable: outcomes.filter((outcome) => outcome.kind === 'skipped_unrecoverable')
      .length,
    failed: outcomes.filter((outcome) => outcome.kind === 'failed').length,
  };
}

function bindingDiagnostic(binding: PaneSessionBinding) {
  return {
    paneId: binding.paneId,
    sessionKind: binding.sessionKind,
    sessionId: binding.sessionId,
    activePtyProcessId: binding.activePtyProcessId,
  };
}

function unrecoverableMetadataError(error: RestoreBindingError) {
  return (
    error._tag === 'AgentSessionError' &&
    (error.code === 'harness_metadata_missing' || error.code === 'harness_metadata_invalid')
  );
}

/** What a failed binding restore reports: the error's tag and code, and for a blocked harness launch, why. */
function failureDiagnostic(error: RestoreBindingError) {
  switch (error._tag) {
    case 'HarnessLaunchBlocked':
      return {
        errorTag: error._tag,
        errorCode: null,
        harness: error.harness,
        errorReason: error.reason,
        errorDiagnostic: error.diagnostic,
        message: `Harness ${error.harness} launch blocked: ${error.reason}.`,
      };
    case 'AgentSessionError':
    case 'TerminalSessionError':
    case 'HarnessAdapterError':
      return { errorTag: error._tag, errorCode: error.code, message: error.message };
    case 'DatabaseError':
      return { errorTag: error._tag, errorCode: null, message: error.message };
  }
}
