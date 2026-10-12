import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type SessionLaunchRejectedError } from '@isagi/contracts';

import { editorRejection } from '../../editor/index.js';
import type { HarnessAdapterError, HarnessLaunchBlocked } from '../../harnesses/index.js';
import {
  registerApiEndpoint,
  type ApiRejected,
  type Rejection,
  type RouteRuntime,
} from '../../platform/http/index.js';
import type { DatabaseError } from '../../platform/persistence/index.js';
import type { SurfaceError, SurfaceOrderError } from './errors.js';
import { SurfaceService } from './service.js';

/**
 * The surfaces routes, plus `editor.open`, which is a placement. Each endpoint maps the service's tagged failures next
 * to it; `DatabaseError` passes through to the platform's `runtime_database_failed`, which every surfaces endpoint
 * declares.
 */
export function registerSurfacesApi(
  fastify: FastifyInstance,
  runtime: RouteRuntime<SurfaceService>,
) {
  registerApiEndpoint(fastify, runtime, apiEndpoints.surfaces.get, (request) =>
    SurfaceService.use((surfaces) => surfaces.getSurfaceDetail(request.params.surfaceId)).pipe(
      Effect.catchTag('SurfaceError', (error) => request.reject(surfaceRejection(error))),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.surfaces.rename, (request) =>
    SurfaceService.use((surfaces) =>
      surfaces.renameSurface({ surfaceId: request.params.surfaceId, title: request.body.title }),
    ).pipe(Effect.catchTag('SurfaceError', (error) => request.reject(surfaceRejection(error)))),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.surfaces.delete, (request) =>
    SurfaceService.use((surfaces) => surfaces.deleteSurface(request.params.surfaceId)).pipe(
      Effect.catchTag('SurfaceError', (error) => request.reject(surfaceRejection(error))),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.surfaces.deletePane, (request) =>
    SurfaceService.use((surfaces) =>
      surfaces.deleteSurfacePane({
        surfaceId: request.params.surfaceId,
        paneId: request.params.paneId,
      }),
    ).pipe(Effect.catchTag('SurfaceError', (error) => request.reject(surfaceRejection(error)))),
  );

  registerApiEndpoint(
    fastify,
    runtime,
    apiEndpoints.surfaces.setWorktreeEnvironmentFocus,
    (request) =>
      SurfaceService.use((surfaces) =>
        surfaces.setWorktreeEnvironmentFocus({
          worktreeId: request.params.worktreeId,
          focus: request.body,
        }),
      ).pipe(
        Effect.catchTag('SurfaceError', (error) =>
          Effect.flatMap(environmentFocusRejection(error), request.reject),
        ),
      ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.surfaces.createSurface, (request) =>
    SurfaceService.use((surfaces) =>
      surfaces.createSurface({
        worktreeId: request.params.worktreeId,
        initialPane: request.body.initialPane,
      }),
    ).pipe(rejectPaneSessionFailures(request.reject)),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.surfaces.splitPane, (request) =>
    SurfaceService.use((surfaces) =>
      surfaces.splitPane({ worktreeId: request.params.worktreeId, split: request.body }),
    ).pipe(rejectPaneSessionFailures(request.reject)),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.surfaces.startPane, (request) =>
    SurfaceService.use((surfaces) =>
      surfaces.startPane({ surfaceId: request.params.surfaceId, start: request.body }),
    ).pipe(rejectPaneSessionFailures(request.reject)),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.surfaces.setSplitWeights, (request) =>
    SurfaceService.use((surfaces) =>
      surfaces.setSplitWeights({ surfaceId: request.params.surfaceId, weights: request.body }),
    ).pipe(Effect.catchTag('SurfaceError', (error) => request.reject(surfaceRejection(error)))),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.surfaces.createPaneSession, (request) =>
    SurfaceService.use((surfaces) =>
      surfaces.createPaneSession({ worktreeId: request.params.worktreeId, create: request.body }),
    ).pipe(rejectPaneSessionFailures(request.reject)),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.surfaces.claimPaneSession, (request) =>
    SurfaceService.use((surfaces) =>
      surfaces.claimPaneSession({ worktreeId: request.params.worktreeId, claim: request.body }),
    ).pipe(rejectPaneSessionFailures(request.reject)),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.surfaces.moveOrder, (request) =>
    SurfaceService.use((surfaces) =>
      surfaces.moveSurfaceOrder({
        worktreeId: request.params.worktreeId,
        surfaceId: request.params.surfaceId,
        beforeSurfaceId: request.body.beforeSurfaceId,
      }),
    ).pipe(
      Effect.catchTag('SurfaceOrderError', (error) => request.reject(surfaceOrderRejection(error))),
    ),
  );

  // Opening an editor is a placement: the surfaces service resolves (or creates) the pane and
  // asks the editor domain for the context it binds there. It answers in the editor's error
  // vocabulary.
  registerApiEndpoint(fastify, runtime, apiEndpoints.editor.open, (request) =>
    SurfaceService.use((surfaces) =>
      surfaces.openEditor({
        worktreeId: request.params.worktreeId,
        intoSurfaceId: request.body.intoSurfaceId,
      }),
    ).pipe(
      Effect.catchTags({
        SurfaceError: (error) => request.reject(editorOpenSurfaceRejection(error)),
        EditorUnavailable: (error) => request.reject(editorRejection(error)),
        DatabaseError: (error) => request.reject(editorRejection(error)),
      }),
    ),
  );
}

/** The rejection union every surfaces endpoint but focus and reorder declares (`surfaceApiErrorSchema`). */
type SurfaceRejection = Rejection<typeof apiEndpoints.surfaces.get>;
type EnvironmentFocusRejection = Rejection<
  typeof apiEndpoints.surfaces.setWorktreeEnvironmentFocus
>;
type SurfaceOrderRejection = Rejection<typeof apiEndpoints.surfaces.moveOrder>;
type EditorOpenRejection = Rejection<typeof apiEndpoints.editor.open>;

/**
 * `SurfaceError`'s codes are exactly the contract's `surface_rejected` reasons, so the reason maps straight through
 * and a code added to one without the other fails to compile here.
 */
export function surfaceRejection(error: SurfaceError) {
  return {
    code: 'surface_rejected',
    status: 400,
    message: error.message,
    data: {
      reason: error.code,
      ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
      ...(error.surfaceId ? { surfaceId: error.surfaceId } : {}),
      ...(error.paneId ? { paneId: error.paneId } : {}),
      ...(error.sessionId ? { sessionId: error.sessionId } : {}),
    },
  } satisfies SurfaceRejection;
}

/**
 * Setting the environment focus refuses only a missing worktree, surface, or pane. Any other surface code reaching
 * this route is a runtime bug, not a reason the contract can carry.
 */
function environmentFocusRejection(error: SurfaceError): Effect.Effect<EnvironmentFocusRejection> {
  switch (error.code) {
    case 'worktree_not_found':
    case 'surface_not_found':
    case 'pane_not_found':
      return Effect.succeed({
        code: 'worktree_environment_focus_rejected',
        status: 400,
        message: error.message,
        data: {
          reason: error.code,
          ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
          ...(error.surfaceId ? { surfaceId: error.surfaceId } : {}),
          ...(error.paneId ? { paneId: error.paneId } : {}),
        },
      });
    case 'session_not_found':
    case 'session_worktree_mismatch':
    case 'invalid_surface_title':
    case 'layout_node_stale':
    case 'surface_not_empty':
      return Effect.die(
        new Error(`Setting the environment focus cannot be refused with ${error.code}.`),
      );
  }
}

function surfaceOrderRejection(error: SurfaceOrderError) {
  return {
    code: 'surface_order_rejected',
    status: 400,
    message: error.message,
    data: {
      reason: error.reason,
      worktreeId: error.worktreeId,
      surfaceId: error.surfaceId,
      ...(error.beforeSurfaceId ? { beforeSurfaceId: error.beforeSurfaceId } : {}),
    },
  } satisfies SurfaceOrderRejection;
}

/** The launch-gate refusal a pane-session route answers when the harness may not start a process here. */
export function sessionLaunchRejection(
  blocked: HarnessLaunchBlocked,
): Omit<SessionLaunchRejectedError, 'requestId'> {
  return {
    code: 'session_launch_rejected',
    status: 400,
    message: `Harness process creation is blocked: ${blocked.reason}.`,
    data: {
      reason: blocked.reason,
      ...(blocked.diagnostic ? { diagnostic: blocked.diagnostic } : {}),
    },
  };
}

/**
 * The pane-session routes (create, split, start, create/claim session) share one failure set.
 *
 * - `HarnessLaunchBlocked` is answered `session_launch_rejected`, the code clients read for it (declared by
 *   `surfaceApiErrorSchema`).
 * - `HarnessAdapterError` has no contract code. It is a defect at this boundary, which answers `api_unhandled_error`
 *   with its message and logs it, as before.
 */
function rejectPaneSessionFailures(
  reject: (rejection: SurfaceRejection) => Effect.Effect<never, ApiRejected<SurfaceRejection>>,
) {
  return <A, R>(
    effect: Effect.Effect<
      A,
      DatabaseError | SurfaceError | HarnessLaunchBlocked | HarnessAdapterError,
      R
    >,
  ) =>
    effect.pipe(
      Effect.catchTags({
        SurfaceError: (error) => reject(surfaceRejection(error)),
        HarnessLaunchBlocked: (blocked) => reject(sessionLaunchRejection(blocked)),
        HarnessAdapterError: (error) => Effect.die(error),
      }),
    );
}

/**
 * `editor.open`'s surface failures. A missing worktree is translated into the editor's own refusal vocabulary, which
 * already names it and which the palette reads; the target-surface refusals (`surface_not_found`,
 * `surface_not_empty`) are surfaces conditions and keep the surfaces rejection, which the editor contract composes.
 */
function editorOpenSurfaceRejection(error: SurfaceError): EditorOpenRejection {
  if (error.code === 'worktree_not_found')
    return {
      code: 'editor_rejected',
      status: 400,
      message: error.message,
      data: {
        reason: 'worktree_not_found',
        ...(error.worktreeId === undefined ? {} : { worktreeId: error.worktreeId }),
      },
    };
  return surfaceRejection(error);
}
