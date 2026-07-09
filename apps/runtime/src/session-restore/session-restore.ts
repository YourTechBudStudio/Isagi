import { Effect, Either, Layer } from 'effect';

import { AgentSessionError, AgentSessionService } from '../agent-sessions/index.js';
import { SurfaceRepository } from '../surfaces/index.js';
import type { PaneSessionBinding } from '../surfaces/types.js';
import { TerminalSessionService } from '../terminal-sessions/index.js';

type RestoreOutcome =
  | { readonly kind: 'reused'; readonly binding: PaneSessionBinding; readonly ptyProcessId: number }
  | {
      readonly kind: 'relaunched';
      readonly binding: PaneSessionBinding;
      readonly ptyProcessId: number;
    }
  | { readonly kind: 'skipped_unrecoverable'; readonly binding: PaneSessionBinding }
  | { readonly kind: 'failed'; readonly binding: PaneSessionBinding };

const restoreStartupSessionsEffect = Effect.gen(function* () {
  const repository = yield* SurfaceRepository;
  const bindings = yield* repository.listPaneSessionBindings;

  // Deliberately unbounded: boot restores the small set of sessions the user
  // already had pane-bound before runtime restart.
  const outcomes = yield* Effect.forEach(bindings, restoreBinding, {
    concurrency: 'unbounded',
  });

  const summary = summarize(outcomes);
  console.info('[runtime][startup-restore] Completed pane-bound session restore', summary);
});

export const restoreStartupSessions = restoreStartupSessionsEffect.pipe(
  Effect.catchAll((error) =>
    Effect.sync(() => {
      console.warn('[runtime][startup-restore] Skipped: binding discovery failed', {
        errorTag: errorTag(error),
        errorCode: errorCode(error),
        message: errorMessage(error),
      });
    }),
  ),
);

export const StartupSessionRestoreLayer = Layer.scopedDiscard(restoreStartupSessions);

function restoreBinding(binding: PaneSessionBinding) {
  return Effect.gen(function* () {
    const agentSessions = yield* AgentSessionService;
    const terminalSessions = yield* TerminalSessionService;
    return yield* restoreWithIsolation(
      binding,
      binding.sessionKind === 'agent_session'
        ? agentSessions.ensureActivePtyProcess(binding.sessionId, {
            replaceEphemeralProcess: true,
          })
        : terminalSessions.ensureActivePtyProcess(binding.sessionId, {
            replaceEphemeralProcess: true,
          }),
    );
  });
}

function restoreWithIsolation(
  binding: PaneSessionBinding,
  restore: Effect.Effect<number, unknown>,
) {
  return Effect.gen(function* () {
    const result = yield* Effect.either(restore);
    if (Either.isRight(result)) {
      const ptyProcessId = result.right;
      return ptyProcessId === binding.activePtyProcessId
        ? ({ kind: 'reused', binding, ptyProcessId } satisfies RestoreOutcome)
        : ({ kind: 'relaunched', binding, ptyProcessId } satisfies RestoreOutcome);
    }

    const error = result.left;
    const kind = unrecoverableMetadataError(error) ? 'skipped_unrecoverable' : 'failed';
    console.warn('[runtime][startup-restore] Failed for pane-bound session', {
      ...bindingDiagnostic(binding),
      outcome: kind,
      errorTag: errorTag(error),
      errorCode: errorCode(error),
      message: errorMessage(error),
    });
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

function unrecoverableMetadataError(error: unknown) {
  return (
    error instanceof AgentSessionError &&
    (error.code === 'harness_metadata_missing' || error.code === 'harness_metadata_invalid')
  );
}

function errorTag(error: unknown) {
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const tagged = error as Record<string, unknown>;
    return String(tagged['_tag']);
  }
  return error instanceof Error ? error.name : typeof error;
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code: unknown }).code)
    : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
