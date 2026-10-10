/**
 * Background synchronization with the runtime: the debounced active-context persistence and the
 * background workspace reconcile. One instance per app session (`backgroundSyncAtom`), owning its
 * fibers; disposing the registry interrupts them.
 */
import { Duration, Effect, FiberHandle, FiberMap } from 'effect';
import { Atom, AtomRegistry, Reactivity } from 'effect/reactivity';

import type { ReconciliationFinding, SetActiveContextInput } from '@isagi/contracts';

import { toastCopy } from '../../copy/index.js';
import { keys } from '../state/keys.js';
import { revalidate } from '../state/policy.js';
import { appRuntime, type AppRequirements } from '../state/runtime.js';
import { showToast } from '../toast/index.js';
import { workspaceReadAtom } from './queries.js';
import { reconcileWorkspace, updateActiveContext } from './runtime-data.js';
import { publishTerminalFactEffect } from './terminal-presentation/facts.js';

/** The selection is persisted this long after it last changed. */
const ACTIVE_CONTEXT_DEBOUNCE = Duration.millis(180);
/** A persistence the runtime does not answer within this is reported as failed. */
const ACTIVE_CONTEXT_TIMEOUT = Duration.seconds(5);

export interface BackgroundSync {
  /**
   * Persist the active context, latest wins. A newer call interrupts the previous one whether it
   * is still in its debounce or already on the wire (the request is aborted), so a superseded
   * write never toasts and never reconciles. The accepted latest re-reads the active context and
   * reconciles its project; a failure of the latest toasts.
   */
  readonly schedule: (activeContext: SetActiveContextInput) => Effect.Effect<void>;
  /**
   * Reconcile one project (or all, `null`) in the background, at most one in flight per project:
   * a call while one runs is dropped. Findings toast, then the workspace is re-read and the
   * terminal inventory is asked to refresh. A failure is logged only.
   */
  readonly reconcile: (projectId: number | null) => Effect.Effect<void>;
}

export const backgroundSyncAtom = appRuntime
  .atom(
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry;
      // The forked work runs on this session's own services, so callers need none.
      const context = yield* Effect.context<AppRequirements>();
      const latest = yield* FiberHandle.make<void, never>();
      const reconciles = yield* FiberMap.make<number | 'all', void, never>();
      let lastRevision = Date.now();
      const nextRevision = () => (lastRevision = Math.max(Date.now(), lastRevision + 1));

      const reconcile = (projectId: number | null) =>
        FiberMap.run(
          reconciles,
          projectId ?? 'all',
          Effect.gen(function* () {
            const output = yield* reconcileWorkspace({ projectId });
            handleReconciliationFindings(registry, output.findings);
            yield* revalidate(workspaceReadAtom);
            yield* publishTerminalFactEffect({ type: 'durable_inventory_refresh_requested' });
          }).pipe(
            Effect.catch((error) => Effect.logError('[workspace] reconciliation failed', error)),
            Effect.provideContext(context),
          ),
          { onlyIfMissing: true },
        ).pipe(Effect.asVoid);

      const schedule = (activeContext: SetActiveContextInput) => {
        // Stamped when scheduled, so revisions follow the user's order even across debounces.
        const input = { activeContext, revision: nextRevision() };
        return FiberHandle.run(
          latest,
          Effect.gen(function* () {
            yield* Effect.sleep(ACTIVE_CONTEXT_DEBOUNCE);
            yield* updateActiveContext(input).pipe(
              Effect.timeoutOrElse({
                duration: ACTIVE_CONTEXT_TIMEOUT,
                orElse: () => Effect.fail(new Error('Active context persistence timed out.')),
              }),
            );
            yield* Reactivity.invalidate([keys.activeContext]);
            if (activeContext.projectId !== null) {
              yield* reconcile(activeContext.projectId);
            }
          }).pipe(
            Effect.catch((error) =>
              Effect.andThen(
                Effect.sync(() =>
                  showToast(registry, {
                    id: 'active-context-persist-failed',
                    kind: 'warning',
                    title: toastCopy.activeContextPersistFailed.title,
                    subtitle: toastCopy.activeContextPersistFailed.subtitle,
                  }),
                ),
                Effect.logError('[workspace] active context persistence failed', error),
              ),
            ),
            Effect.provideContext(context),
          ),
        ).pipe(Effect.asVoid);
      };

      return { schedule, reconcile } satisfies BackgroundSync;
    }),
  )
  .pipe(Atom.keepAlive);

const backgroundSync = Atom.getResult(backgroundSyncAtom);

/** Persist the selection's active context (debounced, latest wins). */
export const scheduleActiveContextPersistence = (activeContext: SetActiveContextInput) =>
  Effect.flatMap(backgroundSync, (sync) => sync.schedule(activeContext));

/** Reconcile a project (or every project) in the background, one in flight per project. */
export const scheduleWorkspaceReconcile = (projectId: number | null) =>
  Effect.flatMap(backgroundSync, (sync) => sync.reconcile(projectId));

export function handleReconciliationFindings(
  registry: AtomRegistry.AtomRegistry,
  findings: readonly ReconciliationFinding[],
) {
  if (findings.length === 0) {
    return;
  }

  const missingProjects = findings.filter((finding) => finding.kind === 'project_missing');
  if (missingProjects.length > 0) {
    showToast(registry, {
      id: 'workspace-project-missing',
      kind: 'warning',
      title: toastCopy.reconciliation.missingProjectsTitle(missingProjects),
      subtitle: toastCopy.reconciliation.missingProjectsSubtitle(missingProjects),
      lifetime: { autoDismiss: false },
    });
  }

  const missingWorktrees = findings.filter((finding) => finding.kind === 'worktree_missing');
  if (missingWorktrees.length > 0) {
    showToast(registry, {
      id: 'workspace-worktree-missing',
      kind: 'warning',
      title: toastCopy.reconciliation.missingWorktreesTitle(missingWorktrees),
      subtitle: toastCopy.reconciliation.missingWorktreesSubtitle(missingWorktrees),
      lifetime: { autoDismiss: false },
    });
  }
}
