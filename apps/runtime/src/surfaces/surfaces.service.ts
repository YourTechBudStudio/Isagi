import { unlinkSync } from 'node:fs';

import { Data, Effect, Schema, Context, Layer } from 'effect';

import type {
  DeleteSurfaceOutput,
  RenameSurfaceOutput,
  SetWorktreeEnvironmentFocusInput,
  SurfaceDetail,
  SurfaceDeleteWarning,
  SurfaceLayoutNode,
  WorktreeEnvironmentFocusOutput,
} from '@isagi/contracts';
import { surfaceLayoutNodeSchema } from '@isagi/contracts';

import type { DatabaseError } from '../persistence/index.js';
import { PtyService, type PtyService as PtyServiceShape } from '../pty/pty.service.js';
import { planSurfacePaneDelete } from './delete-plan.js';
import { SurfaceRepository, type SurfaceRepositoryService } from './surfaces.repository.js';
import type {
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  PtySessionRow,
  SurfaceDeletePaneTarget,
  SurfacePaneRow,
  WorktreeDeleteCleanupOutput,
} from './types.js';

export class SurfaceError extends Data.TaggedError('SurfaceError')<{
  readonly code:
    | 'surface_not_found'
    | 'worktree_not_found'
    | 'pane_not_found'
    | 'invalid_surface_title';
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly paneId?: number | undefined;
}> {}

export type SurfaceServiceError = DatabaseError | SurfaceError;

export interface SurfaceService {
  readonly getSurfaceDetail: (
    surfaceId: number,
  ) => Effect.Effect<SurfaceDetail, SurfaceServiceError>;
  readonly renameSurface: (input: {
    readonly surfaceId: number;
    readonly title: string;
  }) => Effect.Effect<RenameSurfaceOutput, SurfaceServiceError>;
  readonly deleteSurface: (
    surfaceId: number,
  ) => Effect.Effect<DeleteSurfaceOutput, SurfaceServiceError>;
  readonly deleteSurfacePane: (input: {
    readonly surfaceId: number;
    readonly paneId: number;
  }) => Effect.Effect<DeleteSurfaceOutput, SurfaceServiceError>;
  readonly cleanupWorktreeForDelete: (
    worktreeId: number,
  ) => Effect.Effect<WorktreeDeleteCleanupOutput, SurfaceServiceError>;
  readonly createSinglePaneSurface: (
    input: CreateSinglePaneSurfaceInput,
  ) => Effect.Effect<CreateSinglePaneSurfaceOutput, SurfaceServiceError>;
  readonly setWorktreeEnvironmentFocus: (input: {
    readonly worktreeId: number;
    readonly focus: SetWorktreeEnvironmentFocusInput;
  }) => Effect.Effect<WorktreeEnvironmentFocusOutput, SurfaceServiceError>;
}

export const SurfaceService = Context.GenericTag<SurfaceService>('isagi/SurfaceService');

export const SurfaceServiceLive = Layer.effect(
  SurfaceService,
  Effect.gen(function* () {
    const repository = yield* SurfaceRepository;
    const pty = yield* PtyService;

    return {
      getSurfaceDetail: (surfaceId) =>
        Effect.gen(function* () {
          const surface = yield* repository.findSurface(surfaceId);
          if (!surface) {
            return yield* Effect.fail(
              new SurfaceError({
                code: 'surface_not_found',
                message: `Surface ${surfaceId} was not found.`,
                surfaceId,
              }),
            );
          }

          const panes = yield* repository.listPanesForSurface(surface.id);
          const ptySessions = yield* repository.listPtySessionsForPanes(
            panes.map((pane) => pane.id),
          );
          const focus = yield* repository.findEnvironmentFocus(surface.worktreeId);
          const activePaneId = activePaneForSurface(surface.id, panes, focus);

          return {
            id: surface.id,
            worktreeId: surface.worktreeId,
            kind: surface.kind,
            title: surface.title,
            attention: surface.attention,
            layout: decodeLayout(surface.layoutJson),
            activePaneId,
            panes: panes.map((pane) => ({
              id: pane.id,
              surfaceId: pane.surfaceId,
              title: pane.title,
              attention: pane.attention,
              sortOrder: pane.sortOrder,
              ptySession: ptySessionForPane(ptySessions, pane.id),
            })),
          } satisfies SurfaceDetail;
        }),
      renameSurface: (input) =>
        Effect.gen(function* () {
          const title = yield* validateSurfaceTitle(input.title);
          const surface = yield* repository.findSurface(input.surfaceId);
          if (!surface) {
            return yield* Effect.fail(
              new SurfaceError({
                code: 'surface_not_found',
                message: `Surface ${input.surfaceId} was not found.`,
                surfaceId: input.surfaceId,
              }),
            );
          }
          return yield* repository.renameSurface({
            surfaceId: input.surfaceId,
            title,
          });
        }),
      deleteSurface: (surfaceId) =>
        Effect.gen(function* () {
          const target = yield* loadDeleteTarget(repository, surfaceId);
          const cleanup = yield* cleanupLiveSessionsForPanes(pty, target.panes);
          const deleted = yield* repository.deleteSurface(target);
          const logWarnings = deleteLogsForPanes(target.panes);
          return {
            deletedSurfaceId: deleted.deletedSurfaceId,
            deletedPaneIds: [...deleted.deletedPaneIds],
            attemptedPtySessionIds: cleanup.attemptedPtySessionIds,
            warnings: [...cleanup.warnings, ...logWarnings],
          } satisfies DeleteSurfaceOutput;
        }),
      deleteSurfacePane: (input) =>
        Effect.gen(function* () {
          const target = yield* loadDeleteTarget(repository, input.surfaceId);
          const paneTarget = target.panes.find(({ pane }) => pane.id === input.paneId);
          if (!paneTarget) {
            return yield* Effect.fail(
              new SurfaceError({
                code: 'pane_not_found',
                message: `Pane ${input.paneId} was not found for surface ${input.surfaceId}.`,
                surfaceId: input.surfaceId,
                paneId: input.paneId,
              }),
            );
          }

          const plan = planSurfacePaneDelete(target, input.paneId);
          const deletedPaneIds = new Set(plan.deletedPaneIds);
          const cleanupTarget = {
            ...target,
            panes: target.panes.filter(({ pane }) => deletedPaneIds.has(pane.id)),
          };
          const cleanup = yield* cleanupLiveSessionsForPanes(pty, cleanupTarget.panes);
          const deleted = yield* repository.deleteSurfacePane({
            target,
            plan,
          });
          const logWarnings = deleteLogsForPanes(
            target.panes.filter(({ pane }) => deletedPaneIds.has(pane.id)),
          );
          return {
            deletedSurfaceId: deleted.deletedSurfaceId,
            deletedPaneIds: [...deleted.deletedPaneIds],
            attemptedPtySessionIds: cleanup.attemptedPtySessionIds,
            warnings: [...cleanup.warnings, ...logWarnings],
          } satisfies DeleteSurfaceOutput;
        }),
      cleanupWorktreeForDelete: (worktreeId) =>
        Effect.gen(function* () {
          const exists = yield* repository.worktreeExists(worktreeId);
          if (!exists) {
            return yield* Effect.fail(
              new SurfaceError({
                code: 'worktree_not_found',
                message: `Worktree ${worktreeId} was not found.`,
                worktreeId,
              }),
            );
          }

          const targets = yield* repository.listWorktreeDeleteTargets(worktreeId);
          const panes = targets.flatMap((target) => target.panes);
          const cleanup = yield* cleanupLiveSessionsForPanes(pty, panes);
          const logWarnings = deleteLogsForPanes(panes);
          return {
            attemptedPtySessionIds: cleanup.attemptedPtySessionIds,
            warnings: [...cleanup.warnings, ...logWarnings],
          } satisfies WorktreeDeleteCleanupOutput;
        }),
      createSinglePaneSurface: (input) =>
        Effect.gen(function* () {
          const exists = yield* repository.worktreeExists(input.worktreeId);
          if (!exists) {
            return yield* Effect.fail(
              new SurfaceError({
                code: 'worktree_not_found',
                message: `Worktree ${input.worktreeId} was not found.`,
                worktreeId: input.worktreeId,
              }),
            );
          }
          return yield* repository.createSinglePaneSurface(input);
        }),
      setWorktreeEnvironmentFocus: (input) =>
        Effect.gen(function* () {
          const exists = yield* repository.worktreeExists(input.worktreeId);
          if (!exists) {
            return yield* Effect.fail(
              new SurfaceError({
                code: 'worktree_not_found',
                message: `Worktree ${input.worktreeId} was not found.`,
                worktreeId: input.worktreeId,
              }),
            );
          }

          if (input.focus.activeSurfaceId !== null) {
            const surface = yield* repository.findSurface(input.focus.activeSurfaceId);
            if (!surface || surface.worktreeId !== input.worktreeId) {
              return yield* Effect.fail(
                new SurfaceError({
                  code: 'surface_not_found',
                  message: `Surface ${input.focus.activeSurfaceId} was not found for worktree ${input.worktreeId}.`,
                  worktreeId: input.worktreeId,
                  surfaceId: input.focus.activeSurfaceId,
                }),
              );
            }
          }

          if (input.focus.activePaneId !== null) {
            const pane = yield* repository.findPane(input.focus.activePaneId);
            if (!pane || pane.surfaceId !== input.focus.activeSurfaceId) {
              return yield* Effect.fail(
                new SurfaceError({
                  code: 'pane_not_found',
                  message: `Pane ${input.focus.activePaneId} was not found for surface ${input.focus.activeSurfaceId}.`,
                  worktreeId: input.worktreeId,
                  surfaceId: input.focus.activeSurfaceId ?? undefined,
                  paneId: input.focus.activePaneId,
                }),
              );
            }
          }

          return yield* repository.setEnvironmentFocus({
            worktreeId: input.worktreeId,
            activeSurfaceId: input.focus.activeSurfaceId,
            activePaneId: input.focus.activePaneId,
          });
        }),
    } satisfies SurfaceService;
  }),
);

function validateSurfaceTitle(title: string) {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 80) {
    return Effect.fail(
      new SurfaceError({
        code: 'invalid_surface_title',
        message: 'Surface title must be between 1 and 80 characters.',
      }),
    );
  }
  return Effect.succeed(trimmed);
}

function loadDeleteTarget(
  repository: Pick<SurfaceRepositoryService, 'findSurfaceDeleteTarget'>,
  surfaceId: number,
) {
  return Effect.gen(function* () {
    const target = yield* repository.findSurfaceDeleteTarget(surfaceId);
    if (!target) {
      return yield* Effect.fail(
        new SurfaceError({
          code: 'surface_not_found',
          message: `Surface ${surfaceId} was not found.`,
          surfaceId,
        }),
      );
    }
    return target;
  });
}

function cleanupLiveSessionsForPanes(
  pty: Pick<PtyServiceShape, 'cleanupSessionForDelete'>,
  panes: readonly SurfaceDeletePaneTarget[],
) {
  return Effect.gen(function* () {
    const attemptedPtySessionIds: number[] = [];
    const warnings: SurfaceDeleteWarning[] = [];
    for (const { ptySession } of panes) {
      if (!ptySession || (ptySession.status !== 'starting' && ptySession.status !== 'running')) {
        continue;
      }
      attemptedPtySessionIds.push(ptySession.id);
      const sessionWarnings = yield* pty.cleanupSessionForDelete({
        ptySessionId: ptySession.id,
        paneId: ptySession.paneId,
      });
      warnings.push(...sessionWarnings);
    }
    return { attemptedPtySessionIds, warnings };
  });
}

function deleteLogsForPanes(panes: readonly SurfaceDeletePaneTarget[]) {
  const warnings: SurfaceDeleteWarning[] = [];
  for (const { pane, ptySession } of panes) {
    if (!ptySession?.logPath) {
      continue;
    }
    try {
      unlinkSync(ptySession.logPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      console.warn(
        `[runtime] Failed to delete PTY log for deleted pane paneId=${pane.id} ptySessionId=${ptySession.id}`,
        error,
      );
      warnings.push({
        code: 'pty_log_delete_failed',
        paneId: pane.id,
        ptySessionId: ptySession.id,
      });
    }
  }
  return warnings;
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function activePaneForSurface(
  surfaceId: number,
  panes: readonly SurfacePaneRow[],
  focus: {
    readonly activeSurfaceId: number | null;
    readonly activePaneId: number | null;
  } | null,
) {
  if (focus?.activeSurfaceId !== surfaceId || focus.activePaneId === null) {
    return null;
  }
  return panes.some((pane) => pane.id === focus.activePaneId) ? focus.activePaneId : null;
}

function ptySessionForPane(ptySessions: readonly PtySessionRow[], paneId: number) {
  const session = ptySessions.find((candidate) => candidate.paneId === paneId);
  if (!session) {
    return null;
  }
  return {
    id: session.id,
    paneId: session.paneId,
    worktreeId: session.worktreeId,
    backend: session.backend,
    purpose: session.purpose,
    harness: session.harness,
    command: session.command,
    cwd: session.cwd,
    status: session.status,
    statusReason: session.statusReason,
    exitCode: session.exitCode,
    signal: session.signal,
    logMode: session.logMode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    exitedAt: session.exitedAt,
    lastSeenAt: session.lastSeenAt,
  };
}

function decodeLayout(layoutJson: string): SurfaceLayoutNode {
  return Schema.decodeUnknownSync(surfaceLayoutNodeSchema)(JSON.parse(layoutJson));
}
