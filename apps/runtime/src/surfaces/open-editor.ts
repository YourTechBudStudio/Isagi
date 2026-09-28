import { Effect } from 'effect';

import type { OpenEditorInput, OpenEditorOutput } from '@isagi/contracts';

import {
  editorLockKey,
  type EditorContextServiceShape,
  type EditorUnavailable,
} from '../editor-contexts/index.js';
import type { EntityLockService } from '../lib/locks/entity-lock.js';
import type { DatabaseError } from '../persistence/index.js';
import type { InternalRuntimeEventBusService } from '../runtime-events/index.js';
import { SurfaceError } from './errors.js';
import type { SurfaceRepositoryService } from './surfaces.repository.js';

/**
 * Placement for the durable editor context: one idempotent, per-worktree locked
 * find-or-create-and-place.
 *
 * It lives beside the service rather than inside it because its responsibility
 * is cohesive and unlike anything else in `SurfaceService` — it is the only
 * operation that reconciles a durable entity owned by another domain with this
 * domain's placement, and the only one that holds a cross-domain lock. It is
 * deliberately absent from the surfaces barrel: `SurfaceServiceLive` is its only
 * caller.
 *
 * It starts no process. The pane's `ensureRuntime` call is the on-demand half.
 *
 * `intoSurfaceId` only matters when the editor is not placed yet: it names an
 * empty surface of this worktree to become the editor's first pane. A placed
 * editor is never moved; opening it answers with where it already is.
 */
export interface OpenEditorDependencies {
  readonly repository: SurfaceRepositoryService;
  readonly editors: EditorContextServiceShape;
  readonly entityLock: EntityLockService;
  readonly eventBus: InternalRuntimeEventBusService;
}

export function openEditor(
  deps: OpenEditorDependencies,
  input: { readonly worktreeId: number } & OpenEditorInput,
): Effect.Effect<OpenEditorOutput, DatabaseError | SurfaceError | EditorUnavailable> {
  const { repository, editors, entityLock, eventBus } = deps;
  const { worktreeId, intoSurfaceId } = input;
  return Effect.gen(function* () {
    // Class C first: an unsupported or unprovisioned runtime refuses before any
    // row is read or written, so a refusal never leaves residue.
    yield* editors.requireAvailable;
    const exists = yield* repository.worktreeExists(worktreeId);
    if (!exists)
      return yield* Effect.fail(
        new SurfaceError({
          code: 'worktree_not_found',
          message: `Worktree ${worktreeId} was not found.`,
          worktreeId,
        }),
      );

    return yield* entityLock.withLock(editorLockKey(worktreeId), (held) =>
      Effect.gen(function* () {
        const existing = yield* editors.findForWorktree(worktreeId);
        if (existing) {
          const placement = yield* repository.findPaneForSession({
            sessionKind: 'editor_context',
            sessionId: existing.id,
          });
          // Already placed: identity is the row and placement is resolved by id,
          // so a renamed, reordered, or rearranged surface converges here with
          // no mutation and no event.
          if (placement) return { ...placement, editorContextId: existing.id };
          yield* requireTargetSurface();
          return yield* placeContext(existing.id);
        }
        // The target is checked before the durable row exists, so a refused
        // target never leaves a fresh, unplaced context behind.
        yield* requireTargetSurface();
        // The durable row is created before the surface only in this branch, and
        // only under the lock, so the unique index never has to arbitrate.
        const fresh = yield* editors.createForWorktree({ held, worktreeId });
        return yield* placeContext(fresh.id);
      }),
    );

    /**
     * Checked only when the editor needs placing: an already placed editor is
     * answered with its placement whatever `intoSurfaceId` names, even a
     * surface that has since been closed.
     */
    function requireTargetSurface() {
      return Effect.gen(function* () {
        if (intoSurfaceId === null) return;
        const surface = yield* repository.findSurface(intoSurfaceId);
        if (!surface || surface.worktreeId !== worktreeId)
          return yield* Effect.fail(
            new SurfaceError({
              code: 'surface_not_found',
              message: `Surface ${intoSurfaceId} was not found for worktree ${worktreeId}.`,
              worktreeId,
              surfaceId: intoSurfaceId,
            }),
          );
      });
    }

    function placeContext(editorContextId: number) {
      return intoSurfaceId === null
        ? placeInNewSurface(editorContextId)
        : placeInEmptySurface(editorContextId, intoSurfaceId);
    }

    function placeInEmptySurface(editorContextId: number, surfaceId: number) {
      return Effect.gen(function* () {
        // Pane, binding, and focus commit together, as below. A surface that
        // gained a pane since the check above is refused with nothing written,
        // and the context stays unplaced for a later open to place.
        const started = yield* repository.startSurfacePane({
          surfaceId,
          titleBase: 'Editor',
          initialSession: { kind: 'editor_context', sessionId: editorContextId },
        });
        if (started.status !== 'started')
          return yield* Effect.fail(
            new SurfaceError({
              code: started.status,
              message:
                started.status === 'surface_not_found'
                  ? `Surface ${surfaceId} was not found.`
                  : `Surface ${surfaceId} already has panes.`,
              worktreeId,
              surfaceId,
            }),
          );
        yield* eventBus.publish({
          type: 'surface_changed',
          payload: { worktreeId, surfaceId, change: 'layout_changed' },
        });
        yield* eventBus.publish({ type: 'editor_context_changed', editorContextId });
        return {
          worktreeId,
          surfaceId,
          paneId: started.paneId,
          editorContextId,
        } satisfies OpenEditorOutput;
      });
    }

    function placeInNewSurface(editorContextId: number) {
      return Effect.gen(function* () {
        // Surface, pane, binding, and focus commit together. If this fails the
        // context is simply left unplaced, which is a normal repairable state a
        // later open resolves through the branch above; what must never happen
        // is a committed surface holding a sessionless editor pane.
        const created = yield* repository.createSinglePaneSurface({
          worktreeId,
          titleBase: 'Editor',
          initialSession: { kind: 'editor_context', sessionId: editorContextId },
        });
        yield* eventBus.publish({
          type: 'surface_changed',
          payload: { worktreeId, surfaceId: created.surfaceId, change: 'created' },
        });
        yield* eventBus.publish({ type: 'editor_context_changed', editorContextId });
        return {
          worktreeId,
          surfaceId: created.surfaceId,
          paneId: created.paneId,
          editorContextId,
        } satisfies OpenEditorOutput;
      });
    }
  });
}
