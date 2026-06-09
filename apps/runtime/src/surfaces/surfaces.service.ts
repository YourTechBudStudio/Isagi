import { Data, Effect, Schema, Context, Layer } from 'effect';

import type {
  SetWorktreeEnvironmentFocusInput,
  SurfaceDetail,
  SurfaceLayoutNode,
  WorktreeEnvironmentFocusOutput,
} from '@isagi/contracts';
import { surfaceLayoutNodeSchema } from '@isagi/contracts';

import type { DatabaseError } from '../persistence/index.js';
import { SurfaceRepository } from './surfaces.repository.js';
import type {
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  PtySessionRow,
  SurfacePaneRow,
} from './types.js';

export class SurfaceError extends Data.TaggedError('SurfaceError')<{
  readonly code: 'surface_not_found' | 'worktree_not_found' | 'pane_not_found';
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

function activePaneForSurface(
  surfaceId: number,
  panes: readonly SurfacePaneRow[],
  focus: { readonly activeSurfaceId: number | null; readonly activePaneId: number | null } | null,
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
    adapter: session.adapter,
    purpose: session.purpose,
    harness: session.harness,
    command: session.command,
    cwd: session.cwd,
    status: session.status,
    exitCode: session.exitCode,
    signal: session.signal,
    logBytes: session.logBytes,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    exitedAt: session.exitedAt,
  };
}

function decodeLayout(layoutJson: string): SurfaceLayoutNode {
  return Schema.decodeUnknownSync(surfaceLayoutNodeSchema)(JSON.parse(layoutJson));
}
