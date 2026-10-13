import { Cause, Context, Effect, Layer } from 'effect';

import type {
  CreateSurfaceOutput,
  DeletePaneOutput,
  DeleteSurfaceOutput,
  OpenEditorInput,
  OpenEditorOutput,
  PaneSessionClaimInput,
  PaneSessionClaimOutput,
  PaneSessionCreateInput,
  PaneSessionSpec,
  RenameSurfaceOutput,
  SetSplitWeightsInput,
  SetSplitWeightsOutput,
  MoveSurfaceOrderOutput,
  SetWorktreeEnvironmentFocusInput,
  SplitPaneInput,
  StartPaneInput,
  SurfaceDetail,
  SurfaceChangedEvent,
  SurfaceOrderRejectionReason,
  WorktreeEnvironmentFocusOutput,
  DurableSessionInventory,
} from '@isagi/contracts';

import {
  deriveEditorContextFacts,
  editorLockKey,
  EditorContextService,
  type EditorContextRow,
  type EditorReadinessObservation,
  type EditorUnavailable,
} from '../../editor/index.js';
import { FluidcastSessions } from '../../fluidcast/index.js';
import type { HarnessAdapterError, HarnessLaunchBlocked } from '../../harnesses/index.js';
import { displayNameForHarness, HarnessAdapterRegistry } from '../../harnesses/index.js';
import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import { InternalEvents } from '../../platform/events/index.js';
import { EntityLock, type EntityLockHeld } from '../../platform/locks/index.js';
import type { DatabaseError } from '../../platform/persistence/index.js';
import { PtyService } from '../../pty-processes/index.js';
import type { PtyLaunchError } from '../../pty-processes/index.js';
import { AgentSessionInteraction, type AgentControl } from '../agent-sessions/interaction.js';
import { AgentSessionService } from '../agent-sessions/service.js';
import { SessionLifecycle } from '../sessions/lifecycle.js';
import { restorePaneBoundSessions } from '../sessions/restore.js';
import { deriveAgentSessionState, deriveTerminalSessionState } from '../sessions/status.js';
import { activePtyProcessIdsForSessions } from '../sessions/teardown.js';
import type { AgentSessionRow, TerminalSessionRow } from '../sessions/types.js';
import { TerminalSessionService } from '../terminal-sessions/service.js';
import { planSurfacePaneDelete, type SurfacePaneDeletePlan } from './delete-plan.js';
import { SurfaceError, SurfaceOrderError } from './errors.js';
import { decodeSurfaceLayout, setNodeWeights } from './layout.js';
import { openEditor } from './open-editor.js';
import { SurfaceRepository } from './repository.js';
import type {
  CreateEmptySurfaceInput,
  CreateEmptySurfaceOutput,
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  EnvironmentFocusRow,
  SurfaceDeleteTarget,
  SurfaceMetadataRow,
  SurfacePaneRow,
  SurfaceRow,
} from './types.js';

export type SurfaceServiceError = DatabaseError | SurfaceError;

/**
 * The reorder method's own union: its refusals are `SurfaceOrderError`s, never `SurfaceError`s, so no other surface
 * operation can be typed to fail with a rejection the reorder contract cannot encode, and the reorder route maps
 * exactly the one refusal its contract declares.
 */
export type MoveSurfaceOrderServiceError = DatabaseError | SurfaceOrderError;
type PaneSessionClaimError =
  | SurfaceServiceError
  | PtyLaunchError
  | HarnessAdapterError
  | HarnessLaunchBlocked;

const make = Effect.gen(function* () {
  const repository = yield* SurfaceRepository;
  const agents = yield* AgentSessionService;
  const terminals = yield* TerminalSessionService;
  const pty = yield* PtyService;
  const lifecycle = yield* SessionLifecycle;
  const eventBus = yield* InternalEvents;
  const editors = yield* EditorContextService;
  const interaction = yield* AgentSessionInteraction;
  const fluidcast = yield* FluidcastSessions;
  const harnesses = yield* HarnessAdapterRegistry;
  // The same module-scoped lock value `SessionLifecycle` and
  // `EditorContextService` are built on, so placement and the editor's own
  // lifecycle genuinely serialize against each other.
  const entityLock = yield* EntityLock;
  const sessionDeps: PaneSessionDependencies = {
    repository,
    agents,
    terminals,
    lifecycle,
    eventBus,
  };

  const deleteSurfacePane = Effect.fn('SurfaceService.deleteSurfacePane')(function* (input: {
    readonly surfaceId: number;
    readonly paneId: number;
  }) {
    const target = yield* loadDeleteTargetOrNull(repository, input.surfaceId);
    if (!target) return emptyPaneDeleteOutput;
    if (!target.panes.some(({ pane }) => pane.id === input.paneId)) return emptyPaneDeleteOutput;
    const plan = planSurfacePaneDelete(target, input.paneId);
    const deps = { repository, pty, eventBus, editors, entityLock, agents };
    // The lock decision inspects the pane the plan will actually delete,
    // not whether the surface happens to hold an editor. Deleting an
    // unrelated terminal pane from a surface that also holds one keeps the
    // fast path; only deleting the editor pane itself needs the lock.
    if (editorContextIdsOfPanes(panesForPlan(target, plan)).length === 0)
      return yield* deletePlannedPanes(deps, target, plan, input.paneId, null);
    return yield* entityLock.withLock(editorLockKey(target.surface.worktreeId), (held) =>
      Effect.gen(function* () {
        const fresh = yield* loadDeleteTargetOrNull(repository, input.surfaceId);
        if (!fresh) return emptyPaneDeleteOutput;
        if (!fresh.panes.some(({ pane }) => pane.id === input.paneId)) return emptyPaneDeleteOutput;
        const freshPlan = planSurfacePaneDelete(fresh, input.paneId);
        return yield* deletePlannedPanes(deps, fresh, freshPlan, input.paneId, held);
      }),
    );
  });

  /**
   * Compensation for a first pane whose session never started. Best effort:
   * the caller is already failing with the cause that matters, and a pane
   * this leaves behind is still closable from its own menu.
   */
  const removeStartedPane = (input: { readonly surfaceId: number; readonly paneId: number }) =>
    deleteSurfacePane(input).pipe(
      // A compensation guard: whatever this cleanup ends with, the caller's own failure is the one reported.
      Effect.catchCause((cause) =>
        Effect.logWarning('Could not remove a first pane whose session failed to start').pipe(
          Effect.annotateLogs({
            ...input,
            cause: describeOperationalCause(Cause.squash(cause)),
          }),
        ),
      ),
    );

  return SurfaceService.of({
    findSurface: Effect.fn('SurfaceService.findSurface')(function* (surfaceId) {
      return yield* repository.findSurface(surfaceId);
    }),
    listWorkspaceSurfaceMetadata: repository.listWorkspaceSurfaceMetadata,
    listEnvironmentFocusStates: repository.listEnvironmentFocusStates,
    listDurableSessions: repository.listDurableSessions,
    restorePaneBoundSessions: restorePaneBoundSessions({
      repository,
      agentSessions: agents,
      terminalSessions: terminals,
    }),
    getSurfaceDetail: Effect.fn('SurfaceService.getSurfaceDetail')(function* (surfaceId) {
      const surface = yield* repository.findSurface(surfaceId);
      if (!surface)
        return yield* new SurfaceError({
          code: 'surface_not_found',
          message: `Surface ${surfaceId} was not found.`,
          surfaceId,
        });
      const panes = yield* repository.listPanesForSurface(surface.id);
      const paneIds = panes.map((pane) => pane.id);
      const [agentSessions, terminalSessions, editorContexts] = yield* Effect.all([
        repository.listAgentSessionsForPanes(paneIds),
        repository.listTerminalSessionsForPanes(paneIds),
        repository.listEditorContextsForPanes(paneIds),
      ]);
      // Readiness is the editor service's in-memory half of the projection:
      // it belongs to the current incarnation and is deliberately not
      // persisted, so it is composed here rather than joined in SQL.
      const readiness = yield* editors.readinessFor(
        editorContexts.flatMap((row) => (row.activePtyProcessId ? [row.activePtyProcessId] : [])),
      );
      const focus = yield* repository.findEnvironmentFocus(surface.worktreeId);
      const activePaneId = activePaneForSurface(surface.id, panes, focus);
      return {
        id: surface.id,
        worktreeId: surface.worktreeId,
        title: surface.title,
        layout: decodeSurfaceLayout(surface.layoutJson),
        activePaneId,
        panes: panes.map((pane) => ({
          id: pane.id,
          surfaceId: pane.surfaceId,
          title: pane.title,
          sortOrder: pane.sortOrder,
          session: sessionForPane(
            {
              agentSessions,
              terminalSessions,
              editorContexts,
              readiness,
              control: interaction.control,
              // The launch gate stays out of this read: a harness that cannot launch already shows
              // the blocked view, and the switch itself re-checks the gate.
              fluidcastAvailable: (harness) =>
                harnesses.supportsSdk(harness) && fluidcast.availability === 'ready',
            },
            pane,
          ),
        })),
      } satisfies SurfaceDetail;
    }),
    openEditor: Effect.fn('SurfaceService.openEditor')(function* (input) {
      return yield* openEditor({ repository, editors, entityLock, eventBus }, input);
    }),
    renameSurface: Effect.fn('SurfaceService.renameSurface')(function* (input) {
      const title = yield* validateSurfaceTitle(input.title);
      const surface = yield* repository.findSurface(input.surfaceId);
      if (!surface)
        return yield* new SurfaceError({
          code: 'surface_not_found',
          message: `Surface ${input.surfaceId} was not found.`,
          surfaceId: input.surfaceId,
        });
      const output = yield* repository.renameSurface({ surfaceId: input.surfaceId, title });
      yield* publishSurfaceChanged(eventBus, {
        worktreeId: surface.worktreeId,
        surfaceId: input.surfaceId,
        change: 'renamed',
      });
      return output;
    }),
    deleteSurface: Effect.fn('SurfaceService.deleteSurface')(function* (surfaceId) {
      const target = yield* loadDeleteTarget(repository, surfaceId);
      const deps = { repository, pty, eventBus, editors, entityLock, agents };
      // Deleting this surface removes every one of its panes, so the whole
      // capture is what the lock decision inspects.
      if (editorContextIdsOfPanes(target.panes.map(({ pane }) => pane)).length === 0)
        return yield* deleteWholeSurface(deps, target, null);
      return yield* entityLock.withLock(editorLockKey(target.surface.worktreeId), (held) =>
        Effect.gen(function* () {
          const fresh = yield* loadDeleteTargetOrNull(repository, surfaceId);
          if (!fresh) return emptyDeleteOutput;
          return yield* deleteWholeSurface(deps, fresh, held);
        }),
      );
    }),
    deleteSurfacePane,
    createSurface: Effect.fn('SurfaceService.createSurface')(function* (input) {
      const surface = yield* repository.createSinglePaneSurface({
        worktreeId: input.worktreeId,
        titleBase: titleBaseForInitialPane(input.initialPane),
      });
      yield* createPaneSession(
        sessionDeps,
        input.worktreeId,
        paneSessionCreateInput(surface.paneId, input.initialPane),
      );
      yield* publishSurfaceChanged(eventBus, {
        worktreeId: input.worktreeId,
        surfaceId: surface.surfaceId,
        change: 'created',
      });
      return {
        worktreeId: input.worktreeId,
        surfaceId: surface.surfaceId,
        paneId: surface.paneId,
        title: surface.title,
      } satisfies CreateSurfaceOutput;
    }),
    splitPane: Effect.fn('SurfaceService.splitPane')(function* (input) {
      const target = yield* loadPaneSessionTarget(repository, input.worktreeId, input.split.paneId);
      const split = yield* repository.splitSurfacePane({
        surfaceId: target.surface.id,
        sourcePaneId: target.pane.id,
        titleBase: titleBaseForInitialPane(input.split.newPane),
        direction: input.split.direction,
      });
      if (!split)
        return yield* new SurfaceError({
          code: 'pane_not_found',
          message: `Pane ${input.split.paneId} was not found in the surface layout.`,
          worktreeId: input.worktreeId,
          surfaceId: target.surface.id,
          paneId: input.split.paneId,
        });
      yield* createPaneSession(
        sessionDeps,
        input.worktreeId,
        paneSessionCreateInput(split.paneId, input.split.newPane),
      );
      yield* publishSurfaceChanged(eventBus, {
        worktreeId: input.worktreeId,
        surfaceId: split.surfaceId,
        change: 'layout_changed',
      });
      return {
        worktreeId: input.worktreeId,
        surfaceId: split.surfaceId,
        paneId: split.paneId,
        title: split.title,
      } satisfies CreateSurfaceOutput;
    }),
    startPane: Effect.fn('SurfaceService.startPane')(function* (input) {
      const newPane = input.start.newPane;
      const started = yield* repository.startSurfacePane({
        surfaceId: input.surfaceId,
        titleBase: titleBaseForInitialPane(newPane),
      });
      if (started.status === 'surface_not_found')
        return yield* new SurfaceError({
          code: 'surface_not_found',
          message: `Surface ${input.surfaceId} was not found.`,
          surfaceId: input.surfaceId,
        });
      if (started.status === 'surface_not_empty')
        return yield* new SurfaceError({
          code: 'surface_not_empty',
          message: `Surface ${input.surfaceId} already has panes; split one instead.`,
          worktreeId: started.worktreeId,
          surfaceId: input.surfaceId,
        });
      // The pane exists first, then its session is created and bound. If
      // that fails the pane is removed again, so the surface goes back to
      // honestly empty (with its start actions) rather than holding a
      // sessionless pane nothing will ever claim.
      yield* createPaneSession(
        sessionDeps,
        started.worktreeId,
        paneSessionCreateInput(started.paneId, newPane),
      ).pipe(
        Effect.onError(() =>
          removeStartedPane({
            surfaceId: started.surfaceId,
            paneId: started.paneId,
          }),
        ),
      );
      yield* publishSurfaceChanged(eventBus, {
        worktreeId: started.worktreeId,
        surfaceId: started.surfaceId,
        change: 'layout_changed',
      });
      return {
        worktreeId: started.worktreeId,
        surfaceId: started.surfaceId,
        paneId: started.paneId,
        title: started.title,
      } satisfies CreateSurfaceOutput;
    }),
    setSplitWeights: Effect.fn('SurfaceService.setSplitWeights')(function* (input) {
      const surface = yield* repository.findSurface(input.surfaceId);
      if (!surface)
        return yield* new SurfaceError({
          code: 'surface_not_found',
          message: `Surface ${input.surfaceId} was not found.`,
          surfaceId: input.surfaceId,
        });
      const layout = decodeSurfaceLayout(surface.layoutJson);
      const nextLayout =
        layout && setNodeWeights(layout, input.weights.nodeId, input.weights.weights);
      if (!nextLayout)
        return yield* new SurfaceError({
          code: 'layout_node_stale',
          message: `Layout node ${input.weights.nodeId} is no longer valid for surface ${input.surfaceId}.`,
          surfaceId: input.surfaceId,
        });
      const output = yield* repository.setSurfaceLayout({
        surfaceId: input.surfaceId,
        layout: nextLayout,
      });
      yield* publishSurfaceChanged(eventBus, {
        worktreeId: surface.worktreeId,
        surfaceId: input.surfaceId,
        change: 'layout_changed',
      });
      return output;
    }),
    createPaneSession: Effect.fn('SurfaceService.createPaneSession')(function* (input) {
      const output = yield* createPaneSession(sessionDeps, input.worktreeId, input.create);
      yield* publishSurfaceChanged(eventBus, {
        worktreeId: output.worktreeId,
        surfaceId: output.surfaceId,
        change: 'session_changed',
      });
      return output;
    }),
    claimPaneSession: Effect.fn('SurfaceService.claimPaneSession')(function* (input) {
      const output = yield* claimPaneSession(sessionDeps, input.worktreeId, input.claim);
      yield* publishSurfaceChanged(eventBus, {
        worktreeId: output.worktreeId,
        surfaceId: output.surfaceId,
        change: 'session_changed',
      });
      return output;
    }),
    createSinglePaneSurface: Effect.fn('SurfaceService.createSinglePaneSurface')(function* (input) {
      // Validated here and not only in `renameSurface`: a title that cannot be set by rename
      // has no business being created either, and launch-time placement validation calls the
      // same rule so a title is refused before anything is allocated rather than after.
      const titleBase = yield* validateSurfaceTitle(input.titleBase);
      const output = yield* repository.createSinglePaneSurface({ ...input, titleBase });
      yield* publishSurfaceChanged(eventBus, {
        worktreeId: input.worktreeId,
        surfaceId: output.surfaceId,
        change: 'created',
      });
      return output;
    }),
    createEmptySurface: Effect.fn('SurfaceService.createEmptySurface')(function* (input) {
      const titleBase = yield* validateSurfaceTitle(input.titleBase);
      const output = yield* repository.createEmptySurface({ ...input, titleBase });
      yield* publishSurfaceChanged(eventBus, {
        worktreeId: input.worktreeId,
        surfaceId: output.surfaceId,
        change: 'created',
      });
      return output;
    }),
    setWorktreeEnvironmentFocus: Effect.fn('SurfaceService.setWorktreeEnvironmentFocus')(
      function* (input) {
        return yield* setWorktreeEnvironmentFocus(repository, input);
      },
    ),
    // Reordering changes no surface's identity, panes, sessions, or layout, so
    // it publishes no `surface_changed` event: that event drives surface-detail
    // invalidation, and nothing in a surface's detail has changed. The client
    // that issued the move refetches the workspace snapshot itself.
    moveSurfaceOrder: Effect.fn('SurfaceService.moveSurfaceOrder')(function* (input) {
      const result = yield* repository.moveSurfaceOrder(input);
      if (result.status === 'moved')
        return { worktreeId: input.worktreeId, surfaceId: input.surfaceId };
      return yield* new SurfaceOrderError({
        reason: result.reason,
        message: surfaceOrderMessage(result.reason),
        worktreeId: input.worktreeId,
        surfaceId: input.surfaceId,
        ...(input.beforeSurfaceId === null ? {} : { beforeSurfaceId: input.beforeSurfaceId }),
      });
    }),
  });
});

interface SurfaceServiceShape {
  readonly getSurfaceDetail: (
    surfaceId: number,
  ) => Effect.Effect<SurfaceDetail, SurfaceServiceError>;
  /** One surface row, or `null`. A plain read for modules that place work onto surfaces. */
  readonly findSurface: (surfaceId: number) => Effect.Effect<SurfaceRow | null, DatabaseError>;
  /** Every surface's rail metadata, for the workspace snapshot and workflow placement. */
  readonly listWorkspaceSurfaceMetadata: Effect.Effect<SurfaceMetadataRow[], DatabaseError>;
  /** Every worktree's persisted environment focus, for the workspace snapshot. */
  readonly listEnvironmentFocusStates: Effect.Effect<EnvironmentFocusRow[], DatabaseError>;
  /**
   * Every durable session the runtime still owns, with its worktree scope: the authoritative set
   * clients reconcile their cached terminals against.
   */
  readonly listDurableSessions: Effect.Effect<DurableSessionInventory, DatabaseError>;
  /**
   * Startup: relaunches (or reuses) every pane-bound session's process, each in isolation. Never
   * fails; outcomes are logged (`sessions/restore.ts`).
   */
  readonly restorePaneBoundSessions: Effect.Effect<void>;
  /**
   * Idempotent placement of the worktree's one durable editor context. Starts no
   * process: the pane's `ensureRuntime` call is the on-demand half.
   */
  readonly openEditor: (
    input: { readonly worktreeId: number } & OpenEditorInput,
  ) => Effect.Effect<OpenEditorOutput, SurfaceServiceError | EditorUnavailable>;
  readonly renameSurface: (input: {
    readonly surfaceId: number;
    readonly title: string;
  }) => Effect.Effect<RenameSurfaceOutput, SurfaceServiceError>;
  readonly deleteSurface: (
    surfaceId: number,
  ) => Effect.Effect<DeleteSurfaceOutput, SurfaceServiceError>;
  /** Deleting the last pane leaves the surface empty; it never deletes the surface. */
  readonly deleteSurfacePane: (input: {
    readonly surfaceId: number;
    readonly paneId: number;
  }) => Effect.Effect<DeletePaneOutput, SurfaceServiceError>;
  readonly createSurface: (input: {
    readonly worktreeId: number;
    readonly initialPane: PaneSessionSpec;
  }) => Effect.Effect<CreateSurfaceOutput, PaneSessionClaimError>;
  readonly splitPane: (input: {
    readonly worktreeId: number;
    readonly split: SplitPaneInput;
  }) => Effect.Effect<CreateSurfaceOutput, PaneSessionClaimError>;
  /** Starts the first pane of an empty surface. A surface that has panes is refused. */
  readonly startPane: (input: {
    readonly surfaceId: number;
    readonly start: StartPaneInput;
  }) => Effect.Effect<CreateSurfaceOutput, PaneSessionClaimError>;
  readonly setSplitWeights: (input: {
    readonly surfaceId: number;
    readonly weights: SetSplitWeightsInput;
  }) => Effect.Effect<SetSplitWeightsOutput, SurfaceServiceError>;
  readonly createPaneSession: (input: {
    readonly worktreeId: number;
    readonly create: PaneSessionCreateInput;
  }) => Effect.Effect<PaneSessionClaimOutput, PaneSessionClaimError>;
  readonly claimPaneSession: (input: {
    readonly worktreeId: number;
    readonly claim: PaneSessionClaimInput;
  }) => Effect.Effect<PaneSessionClaimOutput, PaneSessionClaimError>;
  readonly createSinglePaneSurface: (
    input: CreateSinglePaneSurfaceInput,
  ) => Effect.Effect<CreateSinglePaneSurfaceOutput, SurfaceServiceError>;
  /** A surface with no panes yet, focused. Its first pane is started with `startPane`. */
  readonly createEmptySurface: (
    input: CreateEmptySurfaceInput,
  ) => Effect.Effect<CreateEmptySurfaceOutput, SurfaceServiceError>;
  readonly setWorktreeEnvironmentFocus: (input: {
    readonly worktreeId: number;
    readonly focus: SetWorktreeEnvironmentFocusInput;
  }) => Effect.Effect<WorktreeEnvironmentFocusOutput, SurfaceServiceError>;
  readonly moveSurfaceOrder: (input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly beforeSurfaceId: number | null;
  }) => Effect.Effect<MoveSurfaceOrderOutput, MoveSurfaceOrderServiceError>;
}

export class SurfaceService extends Context.Service<SurfaceService, SurfaceServiceShape>()(
  'isagi/runtime/environment/SurfaceService',
) {
  static readonly layerNoDeps = Layer.effect(SurfaceService, make);
  static readonly layer = SurfaceService.layerNoDeps.pipe(
    Layer.provide([
      AgentSessionInteraction.layer,
      AgentSessionService.layer,
      EditorContextService.layer,
      EntityLock.layer,
      FluidcastSessions.layer,
      HarnessAdapterRegistry.layer,
      InternalEvents.layer,
      PtyService.layer,
      SessionLifecycle.layer,
      SurfaceRepository.layer,
      TerminalSessionService.layer,
    ]),
  );
}

/**
 * Diagnostic only. The web app writes the line a person reads from the stable
 * `reason`; this exists so logs and API responses explain themselves.
 */
function surfaceOrderMessage(reason: SurfaceOrderRejectionReason) {
  switch (reason) {
    case 'worktree_not_found':
      return 'The worktree that owns the surface was not found.';
    case 'surface_not_found':
      return 'The surface being reordered was not found.';
    case 'surface_worktree_mismatch':
      return 'That surface belongs to a different worktree.';
    case 'before_surface_not_found':
      return 'The surface named as the insertion anchor was not found.';
    case 'before_surface_worktree_mismatch':
      return 'The insertion anchor belongs to a different worktree.';
  }
}

function titleBaseForInitialPane(initialPane: PaneSessionSpec) {
  return initialPane.kind === 'agent_session'
    ? displayNameForHarness(initialPane.harness)
    : 'Terminal';
}

function paneSessionCreateInput(
  paneId: number,
  initialPane: PaneSessionSpec,
): PaneSessionCreateInput {
  return initialPane.kind === 'agent_session'
    ? { kind: 'agent_session', paneId, harness: initialPane.harness }
    : { kind: 'terminal_session', paneId };
}

/** What creating or claiming a pane's session reads and writes. */
interface PaneSessionDependencies {
  readonly repository: SurfaceRepository['Service'];
  readonly agents: AgentSessionService['Service'];
  readonly terminals: TerminalSessionService['Service'];
  readonly lifecycle: SessionLifecycle['Service'];
  readonly eventBus: InternalEvents['Service'];
}

const createPaneSession = Effect.fnUntraced(function* (
  deps: PaneSessionDependencies,
  worktreeId: number,
  create: PaneSessionCreateInput,
) {
  const target = yield* loadPaneSessionTarget(deps.repository, worktreeId, create.paneId);
  const session = yield* resolveCreatedSession(deps, worktreeId, target.cwd, create);
  // If the pane was removed meanwhile (its surface closed during startup), the
  // claim fails and the new, never-started session is left for orphan GC.
  const output = yield* assignPaneSession(deps, {
    worktreeId,
    surfaceId: target.surface.id,
    paneId: target.pane.id,
    session,
  });
  yield* publishReplacedPaneSessionChange(deps.eventBus, target.pane, session);
  return output;
});

const claimPaneSession = Effect.fnUntraced(function* (
  deps: PaneSessionDependencies,
  worktreeId: number,
  claim: PaneSessionClaimInput,
) {
  const target = yield* loadPaneSessionTarget(deps.repository, worktreeId, claim.paneId);
  const session = yield* resolveClaimSession(deps, worktreeId, claim);
  const output = yield* assignPaneSession(deps, {
    worktreeId,
    surfaceId: target.surface.id,
    paneId: target.pane.id,
    session,
  });
  yield* publishReplacedPaneSessionChange(deps.eventBus, target.pane, session);
  return output;
});

const loadPaneSessionTarget = Effect.fnUntraced(function* (
  repository: SurfaceRepository['Service'],
  worktreeId: number,
  paneId: number,
) {
  const pane = yield* repository.findPane(paneId);
  if (!pane)
    return yield* new SurfaceError({
      code: 'pane_not_found',
      message: `Pane ${paneId} was not found.`,
      worktreeId,
      paneId,
    });
  const surface = yield* repository.findSurface(pane.surfaceId);
  if (!surface || surface.worktreeId !== worktreeId)
    return yield* new SurfaceError({
      code: 'pane_not_found',
      message: `Pane ${paneId} was not found for worktree ${worktreeId}.`,
      worktreeId,
      surfaceId: pane.surfaceId,
      paneId,
    });
  const cwd = yield* repository.findWorktreePath(worktreeId);
  if (!cwd)
    return yield* new SurfaceError({
      code: 'worktree_not_found',
      message: `Worktree ${worktreeId} was not found.`,
      worktreeId,
    });
  return { pane, surface, cwd };
});

type PlacedSession = {
  readonly kind: 'agent_session' | 'terminal_session';
  readonly sessionId: number;
};

const assignPaneSession = Effect.fnUntraced(function* (
  deps: PaneSessionDependencies,
  input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly paneId: number;
    readonly session: PlacedSession;
  },
) {
  const { repository, lifecycle, eventBus } = deps;
  const key = { kind: input.session.kind, sessionId: input.session.sessionId };
  // Under the session's lock, shared with process launch and
  // `stopUnlessPlaced`: whoever decides a session is unplaced decides it
  // before or after this binding, never across it.
  const claimed = yield* lifecycle.withRestoreLock(
    key,
    repository.claimPaneSession({
      paneId: input.paneId,
      sessionKind: input.session.kind,
      sessionId: input.session.sessionId,
    }),
  );
  if (claimed !== 'claimed')
    return yield* new SurfaceError({
      code: claimed === 'pane_missing' ? 'pane_not_found' : 'session_not_found',
      message:
        claimed === 'pane_missing'
          ? `Pane ${input.paneId} was removed before its session could be placed.`
          : `Session ${input.session.sessionId} was removed before it could be placed.`,
      worktreeId: input.worktreeId,
      surfaceId: input.surfaceId,
      paneId: input.paneId,
      sessionId: input.session.sessionId,
    });
  yield* lifecycle.supersedeAttachment(key);
  const attachToken = yield* lifecycle.issueAttachToken(key);
  yield* repository.setEnvironmentFocus({
    worktreeId: input.worktreeId,
    activeSurfaceId: input.surfaceId,
    activePaneId: input.paneId,
  });
  yield* publishSessionChanged(eventBus, input.session.kind, input.session.sessionId);

  return {
    worktreeId: input.worktreeId,
    surfaceId: input.surfaceId,
    paneId: input.paneId,
    attachToken: attachToken.token,
    session:
      input.session.kind === 'agent_session'
        ? { kind: 'agent_session', agentSessionId: input.session.sessionId }
        : { kind: 'terminal_session', terminalSessionId: input.session.sessionId },
  } satisfies PaneSessionClaimOutput;
});

const resolveCreatedSession = Effect.fnUntraced(function* (
  deps: PaneSessionDependencies,
  worktreeId: number,
  cwd: string,
  create: PaneSessionCreateInput,
) {
  switch (create.kind) {
    case 'agent_session': {
      const created = yield* deps.agents.startFresh({ worktreeId, harness: create.harness, cwd });
      return { kind: 'agent_session', sessionId: created.agentSessionId } satisfies PlacedSession;
    }
    case 'terminal_session': {
      const created = yield* deps.terminals.startFresh({ worktreeId, cwd });
      return {
        kind: 'terminal_session',
        sessionId: created.terminalSessionId,
      } satisfies PlacedSession;
    }
  }
});

const resolveClaimSession = Effect.fnUntraced(function* (
  deps: PaneSessionDependencies,
  worktreeId: number,
  claim: PaneSessionClaimInput,
) {
  switch (claim.action) {
    case 'claim_agent_session': {
      yield* ensureAgentSessionInWorktree(deps.agents, claim.agentSessionId, worktreeId);
      return { kind: 'agent_session', sessionId: claim.agentSessionId } satisfies PlacedSession;
    }
    case 'claim_terminal_session': {
      yield* ensureTerminalSessionInWorktree(deps.terminals, claim.terminalSessionId, worktreeId);
      return {
        kind: 'terminal_session',
        sessionId: claim.terminalSessionId,
      } satisfies PlacedSession;
    }
  }
});

// The only failing call routed through the two guards below is `get()`, which fails with `session_not_found` (or the
// database). The other session-error codes never reach this path and have no `SurfaceError` equivalent, so mapping
// the tag to `session_not_found` is correct, not lossy.

const ensureAgentSessionInWorktree = Effect.fnUntraced(
  function* (agents: AgentSessionService['Service'], agentSessionId: number, worktreeId: number) {
    const session = yield* agents.get(agentSessionId);
    if (session.worktreeId === worktreeId) return;
    return yield* new SurfaceError({
      code: 'session_worktree_mismatch',
      message: `Agent session ${agentSessionId} does not belong to worktree ${worktreeId}.`,
      worktreeId,
      sessionId: agentSessionId,
    });
  },
  (effect, _agents, agentSessionId, worktreeId) =>
    Effect.catchTag(effect, 'AgentSessionError', (error) =>
      Effect.fail(sessionNotFound(error.message, worktreeId, agentSessionId)),
    ),
);

const ensureTerminalSessionInWorktree = Effect.fnUntraced(
  function* (
    terminals: TerminalSessionService['Service'],
    terminalSessionId: number,
    worktreeId: number,
  ) {
    const session = yield* terminals.get(terminalSessionId);
    if (session.worktreeId === worktreeId) return;
    return yield* new SurfaceError({
      code: 'session_worktree_mismatch',
      message: `Terminal session ${terminalSessionId} does not belong to worktree ${worktreeId}.`,
      worktreeId,
      sessionId: terminalSessionId,
    });
  },
  (effect, _terminals, terminalSessionId, worktreeId) =>
    Effect.catchTag(effect, 'TerminalSessionError', (error) =>
      Effect.fail(sessionNotFound(error.message, worktreeId, terminalSessionId)),
    ),
);

function sessionNotFound(message: string, worktreeId: number, sessionId: number) {
  return new SurfaceError({ code: 'session_not_found', message, worktreeId, sessionId });
}

export function validateSurfaceTitle(title: string) {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 80)
    return Effect.fail(
      new SurfaceError({
        code: 'invalid_surface_title',
        message: 'Surface title must be between 1 and 80 characters.',
      }),
    );
  return Effect.succeed(trimmed);
}

const loadDeleteTarget = Effect.fnUntraced(function* (
  repository: Pick<SurfaceRepository['Service'], 'findSurfaceDeleteTarget'>,
  surfaceId: number,
) {
  const target = yield* repository.findSurfaceDeleteTarget(surfaceId);
  if (!target)
    return yield* new SurfaceError({
      code: 'surface_not_found',
      message: `Surface ${surfaceId} was not found.`,
      surfaceId,
    });
  return target;
});

function activePaneForSurface(
  surfaceId: number,
  panes: readonly SurfacePaneRow[],
  focus: { readonly activeSurfaceId: number | null; readonly activePaneId: number | null } | null,
) {
  if (focus?.activeSurfaceId !== surfaceId || focus.activePaneId === null) return null;
  return panes.some((pane) => pane.id === focus.activePaneId) ? focus.activePaneId : null;
}

const emptyDeleteOutput = {
  deletedSurfaceId: null,
  deletedPaneIds: [],
} satisfies DeleteSurfaceOutput;

const emptyPaneDeleteOutput = { deletedPaneIds: [] } satisfies DeletePaneOutput;

interface SurfaceDeleteDependencies {
  readonly repository: SurfaceRepository['Service'];
  readonly pty: PtyService['Service'];
  readonly eventBus: InternalEvents['Service'];
  readonly editors: EditorContextService['Service'];
  readonly entityLock: EntityLock['Service'];
  readonly agents: AgentSessionService['Service'];
}

function loadDeleteTargetOrNull(repository: SurfaceRepository['Service'], surfaceId: number) {
  return loadDeleteTarget(repository, surfaceId).pipe(
    Effect.catchTag('SurfaceError', (error) =>
      error.code === 'surface_not_found' ? Effect.succeed(null) : Effect.fail(error),
    ),
  );
}

function editorContextIdsOfPanes(panes: readonly SurfacePaneRow[]) {
  return panes.flatMap((pane) =>
    pane.sessionKind === 'editor_context' && pane.sessionId !== null ? [pane.sessionId] : [],
  );
}

function panesForPlan(target: SurfaceDeleteTarget, plan: SurfacePaneDeletePlan) {
  return target.panes
    .map(({ pane }) => pane)
    .filter((pane) => plan.deletedPaneIds.includes(pane.id));
}

/**
 * `deleteSurface`'s body once its target is final. The caller decides whether
 * that target was read under the editor lock; `held` is present exactly when it
 * was, which is what makes releasing an incarnation without the lock
 * unrepresentable rather than merely discouraged.
 */
const deleteWholeSurface = Effect.fnUntraced(function* (
  deps: SurfaceDeleteDependencies,
  target: SurfaceDeleteTarget,
  held: EntityLockHeld | null,
) {
  // Cleanup acts on the panes the delete actually removed, read inside its
  // transaction: a first pane whose session was bound after `target` was
  // read still has that session stopped.
  const deleted = yield* commitAndFinish(
    deps,
    deps.repository.deleteSurface(target.surface.id),
    (rows) =>
      rows.deletedSurfaceId === null
        ? null
        : {
            held,
            surfaceChanged: {
              worktreeId: target.surface.worktreeId,
              surfaceId: target.surface.id,
              change: 'deleted',
              deletedPaneIds: rows.deletedPanes.map((pane) => pane.id),
            },
          },
  );
  if (deleted.deletedSurfaceId === null) return emptyDeleteOutput;
  const deletedPaneIds = deleted.deletedPanes.map((pane) => pane.id);
  return {
    deletedSurfaceId: deleted.deletedSurfaceId,
    deletedPaneIds,
  } satisfies DeleteSurfaceOutput;
});

/** `deleteSurfacePane`'s body once its target and plan are final. */
const deletePlannedPanes = Effect.fnUntraced(function* (
  deps: SurfaceDeleteDependencies,
  target: SurfaceDeleteTarget,
  plan: SurfacePaneDeletePlan,
  requestedPaneId: number,
  held: EntityLockHeld | null,
) {
  // `plan` only decides the lock. The repository re-plans against the rows
  // inside its transaction and removes only what that says, so a concurrent
  // delete can never leave a stale layout behind, and cleanup acts on the
  // sessions bound to the panes it actually removed.
  const deleted = yield* commitAndFinish(
    deps,
    deps.repository.deleteSurfacePane({ surfaceId: target.surface.id, paneId: requestedPaneId }),
    (rows) =>
      rows.deletedPanes.length === 0
        ? null
        : {
            held,
            surfaceChanged: {
              worktreeId: target.surface.worktreeId,
              surfaceId: target.surface.id,
              change: 'pane_deleted',
              deletedPaneIds: rows.deletedPanes.map((pane) => pane.id),
            },
          },
  );
  if (deleted.deletedPanes.length === 0) {
    // The pane existed at load time, yet the repository removed nothing. This
    // is not the idempotent "already gone" case (handled by the caller) — it
    // is a concurrent deletion racing this one, so leave a breadcrumb to
    // distinguish it from a genuine repository miss. Nothing committed, so
    // nothing is published.
    yield* Effect.logWarning(
      'Surface pane delete planned a removal but the repository deleted nothing; treating as already gone',
    ).pipe(
      Effect.annotateLogs({
        surfaceId: target.surface.id,
        paneId: requestedPaneId,
        plannedDeletedPaneIds: plan.deletedPaneIds,
      }),
    );
    return emptyPaneDeleteOutput;
  }
  return {
    deletedPaneIds: deleted.deletedPanes.map((pane) => pane.id),
  } satisfies DeletePaneOutput;
});

type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/**
 * Commits a pane or surface delete, then finishes it, as one sequence no interruption can split
 * once the commit has run. `finishing` names what to finish, or `null` when nothing committed.
 *
 * - **Controllers.** Each deleted agent's current controller (a hidden Fluidcast session, or a
 *   PTY an overlapping terminal switch launched) is ended first, uninterruptibly: once the
 *   placements are gone nothing else would end a Fluidcast session. The agent IDs come straight
 *   from the committed rows, so no read stands between the commit and the release. A switch
 *   queued behind the release is refused, because the placement is gone.
 * - **Publications.** They are installed with `ensuring` inside the protected sequence, before
 *   the release can block, so a caller interrupted during the release or the cleanup still leaves
 *   every client its invalidation event.
 * - **Cleanup.** The rest (PTY teardown, editor release) stays interruptible, as before.
 *
 * Lock order: when the delete holds the worktree's editor lock, the release takes agent locks
 * inside it (editor → agent). Nothing that holds an agent lock may take the editor lock, or the
 * two deadlock. A Codex worker's stop can keep the editor lock for its ~3 s close.
 */
function commitAndFinish<A extends { readonly deletedPanes: readonly SurfacePaneRow[] }, E, R>(
  deps: SurfaceDeleteDependencies,
  commit: Effect.Effect<A, E, R>,
  finishing: (deleted: A) => {
    readonly held: EntityLockHeld | null;
    readonly surfaceChanged: SurfaceChangedEvent['payload'];
  } | null,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const deleted = yield* commit;
      const args = finishing(deleted);
      if (args !== null)
        yield* finishSurfaceDelete(deps, { deletedPanes: deleted.deletedPanes, ...args }, restore);
      return deleted;
    }),
  );
}

/**
 * Everything after the placement removal has committed; runs inside `commitAndFinish`.
 *
 * The publications are installed with `ensuring` rather than sequenced after the
 * cleanup because `releaseIncarnation` can still fail with a `DatabaseError`
 * once the rows are gone. Without this, a client would receive neither a
 * successful response nor the invalidation event, and would keep rendering a
 * surface the database has already deleted. The failure is re-raised after the
 * publication rather than absorbed: durable cleanup did not settle as intended,
 * and reporting success would hide that.
 */
function finishSurfaceDelete(
  deps: SurfaceDeleteDependencies,
  args: {
    readonly deletedPanes: readonly SurfacePaneRow[];
    readonly held: EntityLockHeld | null;
    readonly surfaceChanged: SurfaceChangedEvent['payload'];
  },
  restore: Restore,
) {
  const releaseControllers = deps.agents.releaseControllers(
    args.deletedPanes.flatMap((pane) =>
      pane.sessionKind === 'agent_session' && pane.sessionId !== null ? [pane.sessionId] : [],
    ),
  );
  const cleanup = Effect.gen(function* () {
    // Agents and terminals only. An editor is never routed through this helper:
    // it is best-effort inside a `catchAll`, and clearing an editor's ownership
    // requires the affirmative outcome that discards. Read here, inside the
    // guarded cleanup, so a failed read still publishes the committed delete.
    const sessions = yield* deps.repository.listSessionsBoundTo(args.deletedPanes);
    yield* terminateDeletedPanePtys(deps.pty, sessions);
    const editorContextIds = editorContextIdsOfPanes(args.deletedPanes);
    if (editorContextIds.length === 0) return;
    const release = (held: EntityLockHeld) =>
      Effect.gen(function* () {
        for (const editorContextId of editorContextIds) {
          // Read through the surfaces repository, by the surfaces layer: handing
          // the editor domain a pane read to answer a question about itself
          // would reopen the cycle the one-way dependency exists to prevent.
          const placement = yield* deps.repository.findPaneForSession({
            sessionKind: 'editor_context',
            sessionId: editorContextId,
          });
          // Re-placed or bound elsewhere while we held the lock: never terminate.
          if (placement) continue;
          yield* deps.editors.releaseIncarnation({ held, editorContextId });
        }
      });
    // The delete took the fast path because no editor was there when it looked,
    // but one was placed before it committed (opening an editor into an empty
    // surface). Take the lock now and apply the same release decision.
    yield* args.held
      ? release(args.held)
      : deps.entityLock.withLock(editorLockKey(args.surfaceChanged.worktreeId), release);
  });
  const publications = Effect.gen(function* () {
    yield* publishDeletedPaneSessionChanges(deps.eventBus, args.deletedPanes);
    yield* publishSurfaceChanged(deps.eventBus, args.surfaceChanged);
  });
  return releaseControllers.pipe(Effect.andThen(restore(cleanup)), Effect.ensuring(publications));
}

function terminateDeletedPanePtys(
  pty: PtyService['Service'],
  sessions: {
    readonly agents: readonly AgentSessionRow[];
    readonly terminals: readonly TerminalSessionRow[];
  },
) {
  return pty
    .terminateMany({
      failurePolicy: 'best_effort',
      gracefulTimeoutMs: 1_000,
      operation: 'surface_delete',
      ptyProcessIds: activePtyProcessIdsForSessions(sessions),
    })
    .pipe(Effect.catch(() => Effect.void));
}

function publishSurfaceChanged(
  eventBus: InternalEvents['Service'],
  payload: SurfaceChangedEvent['payload'],
) {
  return eventBus.publish({ type: 'surface_changed', payload });
}

function publishDeletedPaneSessionChanges(
  eventBus: InternalEvents['Service'],
  panes: readonly SurfacePaneRow[],
) {
  return Effect.all(
    panes.flatMap((pane) =>
      pane.sessionKind && pane.sessionId
        ? [publishSessionChanged(eventBus, pane.sessionKind, pane.sessionId)]
        : [],
    ),
    { discard: true },
  );
}

function publishReplacedPaneSessionChange(
  eventBus: InternalEvents['Service'],
  pane: SurfacePaneRow,
  next: { readonly kind: 'agent_session' | 'terminal_session'; readonly sessionId: number },
) {
  const kind = pane.sessionKind;
  if (!kind || !pane.sessionId || (kind === next.kind && pane.sessionId === next.sessionId)) {
    return Effect.void;
  }
  return publishSessionChanged(eventBus, kind, pane.sessionId);
}

/**
 * The normalized "this pane's session changed" publication, total over all three
 * pane kinds.
 *
 * Totality is the point. While this narrowed to the two PTY-backed kinds, an
 * editor pane silently published nothing, so a second client watching a surface
 * whose editor changed would never re-read. The editor's event carries identity
 * only; the projection layer adds placement.
 */
function publishSessionChanged(
  eventBus: InternalEvents['Service'],
  sessionKind: NonNullable<SurfacePaneRow['sessionKind']>,
  sessionId: number,
) {
  switch (sessionKind) {
    case 'agent_session':
      return eventBus.publish({ type: 'agent_session_changed', agentSessionId: sessionId });
    case 'terminal_session':
      return eventBus.publish({ type: 'terminal_session_changed', terminalSessionId: sessionId });
    case 'editor_context':
      return eventBus.publish({ type: 'editor_context_changed', editorContextId: sessionId });
  }
}

function sessionForPane(
  sources: {
    readonly agentSessions: readonly AgentSessionRow[];
    readonly terminalSessions: readonly TerminalSessionRow[];
    readonly editorContexts: readonly EditorContextRow[];
    readonly readiness: ReadonlyMap<number, EditorReadinessObservation>;
    readonly control: (agentSessionId: number) => AgentControl;
    readonly fluidcastAvailable: (harness: AgentSessionRow['harness']) => boolean;
  },
  pane: SurfacePaneRow,
): SurfaceDetail['panes'][number]['session'] {
  const { agentSessions, terminalSessions, editorContexts, readiness } = sources;
  if (pane.sessionKind === 'agent_session' && pane.sessionId !== null) {
    const agent = agentSessions.find((candidate) => candidate.id === pane.sessionId);
    if (!agent) return null;
    const control = sources.control(agent.id);
    const state = deriveAgentSessionState(agent, control);
    return {
      kind: 'agent_session',
      agentSession: {
        id: agent.id,
        paneId: pane.id,
        worktreeId: agent.worktreeId,
        harness: agent.harness,
        cwd: agent.cwd,
        harnessSessionId: agent.harnessSessionId,
        status: state.status,
        statusReason: state.statusReason,
        recoveryAction: state.recoveryAction,
        interaction:
          control.mode === 'fluidcast'
            ? { mode: 'fluidcast', fluidcastSessionId: control.fluidcastSessionId }
            : {
                mode: 'terminal',
                fluidcast: sources.fluidcastAvailable(agent.harness) ? 'available' : 'unavailable',
              },
        diagnosticCode: state.diagnosticCode,
        diagnosticDetail: state.diagnosticDetail,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        lastSeenAt: agent.lastSeenAt,
      },
    };
  }
  if (pane.sessionKind === 'terminal_session' && pane.sessionId !== null) {
    const terminal = terminalSessions.find((candidate) => candidate.id === pane.sessionId);
    if (!terminal) return null;
    const state = deriveTerminalSessionState(terminal);
    return {
      kind: 'terminal_session',
      terminalSession: {
        id: terminal.id,
        paneId: pane.id,
        worktreeId: terminal.worktreeId,
        cwd: terminal.cwd,
        shellCommand: terminal.shellCommand,
        shellArgs: [...terminal.shellArgs],
        status: state.status,
        statusReason: state.statusReason,
        diagnosticCode: state.diagnosticCode,
        diagnosticDetail: state.diagnosticDetail,
        createdAt: terminal.createdAt,
        updatedAt: terminal.updatedAt,
        lastSeenAt: null,
      },
    };
  }
  if (pane.sessionKind === 'editor_context' && pane.sessionId !== null) {
    const context = editorContexts.find((candidate) => candidate.id === pane.sessionId);
    if (!context) return null;
    // Adding `paneId` here is why the contract splits the editor's own facts
    // from this pane-bound metadata: the surfaces layer is the only one that
    // knows placement, and the editor domain is forbidden from reading it.
    return {
      kind: 'editor_context',
      editorContext: {
        paneId: pane.id,
        ...deriveEditorContextFacts(
          context,
          context.activePtyProcessId === null
            ? undefined
            : readiness.get(context.activePtyProcessId),
        ),
      },
    };
  }
  return null;
}

const setWorktreeEnvironmentFocus = Effect.fnUntraced(function* (
  repository: SurfaceRepository['Service'],
  input: { readonly worktreeId: number; readonly focus: SetWorktreeEnvironmentFocusInput },
) {
  const exists = yield* repository.worktreeExists(input.worktreeId);
  if (!exists)
    return yield* Effect.fail(
      new SurfaceError({
        code: 'worktree_not_found',
        message: `Worktree ${input.worktreeId} was not found.`,
        worktreeId: input.worktreeId,
      }),
    );
  if (input.focus.activeSurfaceId !== null) {
    const surface = yield* repository.findSurface(input.focus.activeSurfaceId);
    if (!surface || surface.worktreeId !== input.worktreeId)
      return yield* Effect.fail(
        new SurfaceError({
          code: 'surface_not_found',
          message: `Surface ${input.focus.activeSurfaceId} was not found for worktree ${input.worktreeId}.`,
          worktreeId: input.worktreeId,
          surfaceId: input.focus.activeSurfaceId,
        }),
      );
  }
  if (input.focus.activePaneId !== null) {
    const pane = yield* repository.findPane(input.focus.activePaneId);
    if (!pane || pane.surfaceId !== input.focus.activeSurfaceId)
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
  return yield* repository.setEnvironmentFocus({
    worktreeId: input.worktreeId,
    activeSurfaceId: input.focus.activeSurfaceId,
    activePaneId: input.focus.activePaneId,
  });
});
