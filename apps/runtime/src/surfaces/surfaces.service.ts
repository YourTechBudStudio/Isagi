import { Context, Effect, Layer, Schema } from 'effect';

import type {
  CreateSurfaceOutput,
  DeleteSurfaceOutput,
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
  SurfaceDetail,
  SurfaceChangedEvent,
  SurfaceLayoutNode,
  SurfaceOrderRejectionReason,
  WorktreeEnvironmentFocusOutput,
} from '@isagi/contracts';
import { surfaceLayoutNodeSchema } from '@isagi/contracts';

import { displayNameForHarness } from '../agent-sessions/harness/display.js';
import { HarnessAdapterError } from '../agent-sessions/harness/types.js';
import { AgentSessionError, AgentSessionService } from '../agent-sessions/index.js';
import {
  deriveEditorContextFacts,
  editorLockKey,
  EditorContextService,
  type EditorContextRow,
  type EditorContextServiceShape,
  type EditorReadinessObservation,
  type EditorUnavailable,
} from '../editor-contexts/index.js';
import type { HarnessLaunchBlocked } from '../harness-control-plane/index.js';
import { EntityLock, type EntityLockHeld } from '../lib/locks/entity-lock.js';
import type { DatabaseError } from '../persistence/index.js';
import {
  activePtyProcessIdsForSessions,
  PtyService,
  terminatePtyProcessIds,
  type PtyServiceShape,
} from '../pty-processes/index.js';
import type { PtyLaunchError } from '../pty-processes/pty.service.js';
import {
  InternalRuntimeEventBus,
  type InternalRuntimeEventBusService,
} from '../runtime-events/index.js';
import { SessionLifecycle } from '../session-lifecycle/index.js';
import { TerminalSessionError, TerminalSessionService } from '../terminal-sessions/index.js';
import { planSurfacePaneDelete, type SurfacePaneDeletePlan } from './delete-plan.js';
import { SurfaceError, SurfaceOrderError } from './errors.js';
import { setNodeWeights } from './layout.js';
import { openEditor } from './open-editor.js';
import { deriveAgentSessionState, deriveTerminalSessionState } from './session-status.js';
import { SurfaceRepository, type SurfaceRepositoryService } from './surfaces.repository.js';
import type {
  AgentSessionRow,
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  SurfaceDeleteTarget,
  SurfacePaneRow,
  TerminalSessionRow,
} from './types.js';

export type SurfaceServiceError = DatabaseError | SurfaceError;

/**
 * Extends the shared union for the reorder method only, so no other surface
 * operation can be typed to fail with a rejection its contract cannot encode.
 */
export type MoveSurfaceOrderServiceError = SurfaceServiceError | SurfaceOrderError;
type PaneSessionClaimError =
  | SurfaceServiceError
  | PtyLaunchError
  | HarnessAdapterError
  | HarnessLaunchBlocked;

export interface SurfaceService {
  readonly getSurfaceDetail: (
    surfaceId: number,
  ) => Effect.Effect<SurfaceDetail, SurfaceServiceError>;
  /**
   * Idempotent placement of the worktree's one durable editor context. Starts no
   * process: the pane's `ensureRuntime` call is the on-demand half.
   */
  readonly openEditor: (input: {
    readonly worktreeId: number;
  }) => Effect.Effect<OpenEditorOutput, SurfaceServiceError | EditorUnavailable>;
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
  readonly createSurface: (input: {
    readonly worktreeId: number;
    readonly initialPane: PaneSessionSpec;
  }) => Effect.Effect<CreateSurfaceOutput, PaneSessionClaimError>;
  readonly splitPane: (input: {
    readonly worktreeId: number;
    readonly split: SplitPaneInput;
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

export const SurfaceService = Context.GenericTag<SurfaceService>('isagi/SurfaceService');

export const SurfaceServiceLive = Layer.effect(
  SurfaceService,
  Effect.gen(function* () {
    const repository = yield* SurfaceRepository;
    const agents = yield* AgentSessionService;
    const terminals = yield* TerminalSessionService;
    const pty = yield* PtyService;
    const lifecycle = yield* SessionLifecycle;
    const eventBus = yield* InternalRuntimeEventBus;
    const editors = yield* EditorContextService;
    // The same module-scoped lock value `SessionLifecycle` and
    // `EditorContextService` are built on, so placement and the editor's own
    // lifecycle genuinely serialize against each other.
    const entityLock = yield* EntityLock;

    return {
      getSurfaceDetail: (surfaceId) =>
        Effect.gen(function* () {
          const surface = yield* repository.findSurface(surfaceId);
          if (!surface)
            return yield* Effect.fail(
              new SurfaceError({
                code: 'surface_not_found',
                message: `Surface ${surfaceId} was not found.`,
                surfaceId,
              }),
            );
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
            editorContexts.flatMap((row) =>
              row.activePtyProcessId ? [row.activePtyProcessId] : [],
            ),
          );
          const focus = yield* repository.findEnvironmentFocus(surface.worktreeId);
          const activePaneId = activePaneForSurface(surface.id, panes, focus);
          return {
            id: surface.id,
            worktreeId: surface.worktreeId,
            title: surface.title,
            layout: decodeLayout(surface.layoutJson),
            activePaneId,
            panes: panes.map((pane) => ({
              id: pane.id,
              surfaceId: pane.surfaceId,
              title: pane.title,
              sortOrder: pane.sortOrder,
              session: sessionForPane(
                { agentSessions, terminalSessions, editorContexts, readiness },
                pane,
              ),
            })),
          } satisfies SurfaceDetail;
        }),
      openEditor: (input) => openEditor({ repository, editors, entityLock, eventBus }, input),
      renameSurface: (input) =>
        Effect.gen(function* () {
          const title = yield* validateSurfaceTitle(input.title);
          const surface = yield* repository.findSurface(input.surfaceId);
          if (!surface)
            return yield* Effect.fail(
              new SurfaceError({
                code: 'surface_not_found',
                message: `Surface ${input.surfaceId} was not found.`,
                surfaceId: input.surfaceId,
              }),
            );
          const output = yield* repository.renameSurface({ surfaceId: input.surfaceId, title });
          yield* publishSurfaceChanged(eventBus, {
            worktreeId: surface.worktreeId,
            surfaceId: input.surfaceId,
            change: 'renamed',
          });
          return output;
        }),
      deleteSurface: (surfaceId) =>
        Effect.gen(function* () {
          const target = yield* loadDeleteTarget(repository, surfaceId);
          const deps = { repository, pty, eventBus, editors };
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
      deleteSurfacePane: (input) =>
        Effect.gen(function* () {
          const target = yield* loadDeleteTargetOrNull(repository, input.surfaceId);
          if (!target) return emptyDeleteOutput;
          if (!target.panes.some(({ pane }) => pane.id === input.paneId)) return emptyDeleteOutput;
          const plan = planSurfacePaneDelete(target, input.paneId);
          const deps = { repository, pty, eventBus, editors };
          // The lock decision inspects the panes the plan will actually delete,
          // not whether the surface happens to hold an editor. Deleting an
          // unrelated terminal pane from a surface that also holds one keeps the
          // fast path; only a plan that escalates into removing the editor pane
          // needs the lock.
          if (editorContextIdsOfPanes(panesForPlan(target, plan)).length === 0)
            return yield* deletePlannedPanes(deps, target, plan, input.paneId, null);
          return yield* entityLock.withLock(editorLockKey(target.surface.worktreeId), (held) =>
            Effect.gen(function* () {
              const fresh = yield* loadDeleteTargetOrNull(repository, input.surfaceId);
              if (!fresh) return emptyDeleteOutput;
              if (!fresh.panes.some(({ pane }) => pane.id === input.paneId))
                return emptyDeleteOutput;
              // Re-planned, never reused: another pane deletion may have
              // changed the layout or escalated what this plan removes.
              const freshPlan = planSurfacePaneDelete(fresh, input.paneId);
              return yield* deletePlannedPanes(deps, fresh, freshPlan, input.paneId, held);
            }),
          );
        }),
      createSurface: (input) =>
        Effect.gen(function* () {
          const surface = yield* createSinglePaneSurface(repository, {
            worktreeId: input.worktreeId,
            titleBase: titleBaseForInitialPane(input.initialPane),
          });
          yield* createPaneSession(
            repository,
            agents,
            terminals,
            lifecycle,
            eventBus,
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
      splitPane: (input) =>
        Effect.gen(function* () {
          const target = yield* loadPaneSessionTarget(
            repository,
            input.worktreeId,
            input.split.paneId,
          );
          const split = yield* repository.splitSurfacePane({
            surfaceId: target.surface.id,
            sourcePaneId: target.pane.id,
            titleBase: titleBaseForInitialPane(input.split.newPane),
            direction: input.split.direction,
          });
          if (!split)
            return yield* Effect.fail(
              new SurfaceError({
                code: 'pane_not_found',
                message: `Pane ${input.split.paneId} was not found in the surface layout.`,
                worktreeId: input.worktreeId,
                surfaceId: target.surface.id,
                paneId: input.split.paneId,
              }),
            );
          yield* createPaneSession(
            repository,
            agents,
            terminals,
            lifecycle,
            eventBus,
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
      setSplitWeights: (input) =>
        Effect.gen(function* () {
          const surface = yield* repository.findSurface(input.surfaceId);
          if (!surface)
            return yield* Effect.fail(
              new SurfaceError({
                code: 'surface_not_found',
                message: `Surface ${input.surfaceId} was not found.`,
                surfaceId: input.surfaceId,
              }),
            );
          const layout = decodeLayout(surface.layoutJson);
          const nextLayout = setNodeWeights(layout, input.weights.nodeId, input.weights.weights);
          if (!nextLayout)
            return yield* Effect.fail(
              new SurfaceError({
                code: 'layout_node_stale',
                message: `Layout node ${input.weights.nodeId} is no longer valid for surface ${input.surfaceId}.`,
                surfaceId: input.surfaceId,
              }),
            );
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
      createPaneSession: (input) =>
        Effect.gen(function* () {
          const output = yield* createPaneSession(
            repository,
            agents,
            terminals,
            lifecycle,
            eventBus,
            input.worktreeId,
            input.create,
          );
          yield* publishSurfaceChanged(eventBus, {
            worktreeId: output.worktreeId,
            surfaceId: output.surfaceId,
            change: 'session_changed',
          });
          return output;
        }),
      claimPaneSession: (input) =>
        Effect.gen(function* () {
          const output = yield* claimPaneSession(
            repository,
            agents,
            terminals,
            lifecycle,
            eventBus,
            input.worktreeId,
            input.claim,
          );
          yield* publishSurfaceChanged(eventBus, {
            worktreeId: output.worktreeId,
            surfaceId: output.surfaceId,
            change: 'session_changed',
          });
          return output;
        }),
      createSinglePaneSurface: (input) =>
        Effect.gen(function* () {
          const exists = yield* repository.worktreeExists(input.worktreeId);
          if (!exists)
            return yield* Effect.fail(
              new SurfaceError({
                code: 'worktree_not_found',
                message: `Worktree ${input.worktreeId} was not found.`,
                worktreeId: input.worktreeId,
              }),
            );
          const output = yield* repository.createSinglePaneSurface(input);
          yield* publishSurfaceChanged(eventBus, {
            worktreeId: input.worktreeId,
            surfaceId: output.surfaceId,
            change: 'created',
          });
          return output;
        }),
      setWorktreeEnvironmentFocus: (input) => setWorktreeEnvironmentFocus(repository, input),
      // Reordering changes no surface's identity, panes, sessions, or layout, so
      // it publishes no `surface_changed` event: that event drives surface-detail
      // invalidation, and nothing in a surface's detail has changed. The client
      // that issued the move refetches the workspace snapshot itself.
      moveSurfaceOrder: (input) =>
        repository.moveSurfaceOrder(input).pipe(
          Effect.flatMap((result) =>
            result.status === 'moved'
              ? Effect.succeed({ worktreeId: input.worktreeId, surfaceId: input.surfaceId })
              : Effect.fail(
                  new SurfaceOrderError({
                    reason: result.reason,
                    message: surfaceOrderMessage(result.reason),
                    worktreeId: input.worktreeId,
                    surfaceId: input.surfaceId,
                    ...(input.beforeSurfaceId === null
                      ? {}
                      : { beforeSurfaceId: input.beforeSurfaceId }),
                  }),
                ),
          ),
        ),
    } satisfies SurfaceService;
  }),
);

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

function createSinglePaneSurface(
  repository: SurfaceRepositoryService,
  input: CreateSinglePaneSurfaceInput,
) {
  return Effect.gen(function* () {
    const exists = yield* repository.worktreeExists(input.worktreeId);
    if (!exists)
      return yield* Effect.fail(
        new SurfaceError({
          code: 'worktree_not_found',
          message: `Worktree ${input.worktreeId} was not found.`,
          worktreeId: input.worktreeId,
        }),
      );
    return yield* repository.createSinglePaneSurface(input);
  });
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

function createPaneSession(
  repository: SurfaceRepositoryService,
  agents: import('../agent-sessions/index.js').AgentSessionServiceShape,
  terminals: import('../terminal-sessions/index.js').TerminalSessionServiceShape,
  lifecycle: import('../session-lifecycle/index.js').SessionLifecycleService,
  eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService,
  worktreeId: number,
  create: PaneSessionCreateInput,
): Effect.Effect<PaneSessionClaimOutput, PaneSessionClaimError> {
  return Effect.gen(function* () {
    const target = yield* loadPaneSessionTarget(repository, worktreeId, create.paneId);
    const session = yield* resolveCreatedSession(agents, terminals, worktreeId, target.cwd, create);
    const output = yield* assignPaneSession(repository, lifecycle, eventBus, {
      worktreeId,
      surfaceId: target.surface.id,
      paneId: target.pane.id,
      session,
    });
    yield* publishReplacedPaneSessionChange(eventBus, target.pane, session);
    return output;
  });
}

function claimPaneSession(
  repository: SurfaceRepositoryService,
  agents: import('../agent-sessions/index.js').AgentSessionServiceShape,
  terminals: import('../terminal-sessions/index.js').TerminalSessionServiceShape,
  lifecycle: import('../session-lifecycle/index.js').SessionLifecycleService,
  eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService,
  worktreeId: number,
  claim: PaneSessionClaimInput,
): Effect.Effect<PaneSessionClaimOutput, PaneSessionClaimError> {
  return Effect.gen(function* () {
    const target = yield* loadPaneSessionTarget(repository, worktreeId, claim.paneId);
    const session = yield* resolveClaimSession(agents, terminals, worktreeId, claim);
    const output = yield* assignPaneSession(repository, lifecycle, eventBus, {
      worktreeId,
      surfaceId: target.surface.id,
      paneId: target.pane.id,
      session,
    });
    yield* publishReplacedPaneSessionChange(eventBus, target.pane, session);
    return output;
  });
}

function loadPaneSessionTarget(
  repository: SurfaceRepositoryService,
  worktreeId: number,
  paneId: number,
) {
  return Effect.gen(function* () {
    const pane = yield* repository.findPane(paneId);
    if (!pane)
      return yield* Effect.fail(
        new SurfaceError({
          code: 'pane_not_found',
          message: `Pane ${paneId} was not found.`,
          worktreeId,
          paneId,
        }),
      );
    const surface = yield* repository.findSurface(pane.surfaceId);
    if (!surface || surface.worktreeId !== worktreeId)
      return yield* Effect.fail(
        new SurfaceError({
          code: 'pane_not_found',
          message: `Pane ${paneId} was not found for worktree ${worktreeId}.`,
          worktreeId,
          surfaceId: pane.surfaceId,
          paneId,
        }),
      );
    const cwd = yield* repository.findWorktreePath(worktreeId);
    if (!cwd)
      return yield* Effect.fail(
        new SurfaceError({
          code: 'worktree_not_found',
          message: `Worktree ${worktreeId} was not found.`,
          worktreeId,
        }),
      );
    return { pane, surface, cwd };
  });
}

function assignPaneSession(
  repository: SurfaceRepositoryService,
  lifecycle: import('../session-lifecycle/index.js').SessionLifecycleService,
  eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService,
  input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly paneId: number;
    readonly session: {
      readonly kind: 'agent_session' | 'terminal_session';
      readonly sessionId: number;
    };
  },
) {
  return Effect.gen(function* () {
    const key = { kind: input.session.kind, sessionId: input.session.sessionId };
    yield* repository.claimPaneSession({
      paneId: input.paneId,
      sessionKind: input.session.kind,
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
}

function resolveCreatedSession(
  agents: import('../agent-sessions/index.js').AgentSessionServiceShape,
  terminals: import('../terminal-sessions/index.js').TerminalSessionServiceShape,
  worktreeId: number,
  cwd: string,
  create: PaneSessionCreateInput,
): Effect.Effect<
  { readonly kind: 'agent_session' | 'terminal_session'; readonly sessionId: number },
  PaneSessionClaimError
> {
  return Effect.gen(function* () {
    switch (create.kind) {
      case 'agent_session': {
        const created = yield* agents.startFresh({ worktreeId, harness: create.harness, cwd });
        return { kind: 'agent_session' as const, sessionId: created.agentSessionId };
      }
      case 'terminal_session': {
        const created = yield* terminals.startFresh({ worktreeId, cwd });
        return { kind: 'terminal_session' as const, sessionId: created.terminalSessionId };
      }
    }
    return yield* Effect.die('Unhandled pane session create kind.');
  });
}

function resolveClaimSession(
  agents: import('../agent-sessions/index.js').AgentSessionServiceShape,
  terminals: import('../terminal-sessions/index.js').TerminalSessionServiceShape,
  worktreeId: number,
  claim: PaneSessionClaimInput,
): Effect.Effect<
  { readonly kind: 'agent_session' | 'terminal_session'; readonly sessionId: number },
  PaneSessionClaimError
> {
  return Effect.gen(function* () {
    switch (claim.action) {
      case 'claim_agent_session': {
        yield* ensureAgentSessionInWorktree(agents, claim.agentSessionId, worktreeId);
        return { kind: 'agent_session' as const, sessionId: claim.agentSessionId };
      }
      case 'claim_terminal_session': {
        yield* ensureTerminalSessionInWorktree(terminals, claim.terminalSessionId, worktreeId);
        return { kind: 'terminal_session' as const, sessionId: claim.terminalSessionId };
      }
    }
    return yield* Effect.die('Unhandled pane session claim action.');
  });
}

function ensureAgentSessionInWorktree(
  agents: import('../agent-sessions/index.js').AgentSessionServiceShape,
  agentSessionId: number,
  worktreeId: number,
) {
  return agents.get(agentSessionId).pipe(
    Effect.flatMap((session) => {
      if (session.worktreeId === worktreeId) return Effect.void;
      return Effect.fail(
        new SurfaceError({
          code: 'session_worktree_mismatch',
          message: `Agent session ${agentSessionId} does not belong to worktree ${worktreeId}.`,
          worktreeId,
          sessionId: agentSessionId,
        }),
      );
    }),
    Effect.catchAll((error) =>
      error instanceof AgentSessionError
        ? Effect.fail(sessionSurfaceError(error, worktreeId, agentSessionId))
        : Effect.fail(error),
    ),
  );
}

function ensureTerminalSessionInWorktree(
  terminals: import('../terminal-sessions/index.js').TerminalSessionServiceShape,
  terminalSessionId: number,
  worktreeId: number,
) {
  return terminals.get(terminalSessionId).pipe(
    Effect.flatMap((session) => {
      if (session.worktreeId === worktreeId) return Effect.void;
      return Effect.fail(
        new SurfaceError({
          code: 'session_worktree_mismatch',
          message: `Terminal session ${terminalSessionId} does not belong to worktree ${worktreeId}.`,
          worktreeId,
          sessionId: terminalSessionId,
        }),
      );
    }),
    Effect.catchAll((error) =>
      error instanceof TerminalSessionError
        ? Effect.fail(sessionSurfaceError(error, worktreeId, terminalSessionId))
        : Effect.fail(error),
    ),
  );
}

function sessionSurfaceError(
  error: AgentSessionError | TerminalSessionError,
  worktreeId: number,
  sessionId: number,
) {
  // The only failing call routed here is `get()`, which fails exclusively with
  // `session_not_found`. The other session-error codes never reach this path and
  // have no SurfaceError equivalent, so a single mapping is correct, not lossy.
  return new SurfaceError({
    code: 'session_not_found',
    message: error.message,
    worktreeId,
    sessionId,
  });
}

function validateSurfaceTitle(title: string) {
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

function loadDeleteTarget(
  repository: Pick<SurfaceRepositoryService, 'findSurfaceDeleteTarget'>,
  surfaceId: number,
) {
  return Effect.gen(function* () {
    const target = yield* repository.findSurfaceDeleteTarget(surfaceId);
    if (!target)
      return yield* Effect.fail(
        new SurfaceError({
          code: 'surface_not_found',
          message: `Surface ${surfaceId} was not found.`,
          surfaceId,
        }),
      );
    return target;
  });
}

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

interface SurfaceDeleteDependencies {
  readonly repository: SurfaceRepositoryService;
  readonly pty: PtyServiceShape;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly editors: EditorContextServiceShape;
}

function loadDeleteTargetOrNull(repository: SurfaceRepositoryService, surfaceId: number) {
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
function deleteWholeSurface(
  deps: SurfaceDeleteDependencies,
  target: SurfaceDeleteTarget,
  held: EntityLockHeld | null,
) {
  return Effect.gen(function* () {
    const panes = target.panes.map(({ pane }) => pane);
    const sessions = yield* sessionsForPaneIds(
      deps.repository,
      panes.map((pane) => pane.id),
    );
    const deleted = yield* deps.repository.deleteSurface(target);
    yield* finishSurfaceDelete(deps, {
      sessions,
      deletedPanes: panes,
      editorContextIds: editorContextIdsOfPanes(panes),
      held,
      surfaceChanged: {
        worktreeId: target.surface.worktreeId,
        surfaceId: target.surface.id,
        change: 'deleted',
        deletedPaneIds: [...deleted.deletedPaneIds],
      },
    });
    return {
      deletedSurfaceId: deleted.deletedSurfaceId,
      deletedPaneIds: [...deleted.deletedPaneIds],
    } satisfies DeleteSurfaceOutput;
  });
}

/** `deleteSurfacePane`'s body once its target and plan are final. */
function deletePlannedPanes(
  deps: SurfaceDeleteDependencies,
  target: SurfaceDeleteTarget,
  plan: SurfacePaneDeletePlan,
  requestedPaneId: number,
  held: EntityLockHeld | null,
) {
  return Effect.gen(function* () {
    const sessions = yield* sessionsForPaneIds(deps.repository, plan.deletedPaneIds);
    const deleted = yield* deps.repository.deleteSurfacePane({ target, plan });
    if (deleted.deletedPaneIds.length === 0 && deleted.deletedSurfaceId === null) {
      // A delete plan was built from a pane that existed at load time, yet the
      // repository removed nothing. This is not the idempotent "already gone"
      // case (handled by the caller) — it is a concurrent deletion racing this
      // one, so leave a breadcrumb to distinguish it from a genuine repository
      // miss. Nothing committed, so nothing is published.
      console.warn(
        '[runtime] Surface pane delete planned a removal but the repository deleted nothing; treating as already gone',
        {
          surfaceId: target.surface.id,
          paneId: requestedPaneId,
          plannedDeletedPaneIds: plan.deletedPaneIds,
        },
      );
      return emptyDeleteOutput;
    }
    const deletedPanes = target.panes
      .map(({ pane }) => pane)
      .filter((pane) => deleted.deletedPaneIds.includes(pane.id));
    yield* finishSurfaceDelete(deps, {
      sessions,
      deletedPanes,
      editorContextIds: editorContextIdsOfPanes(deletedPanes),
      held,
      surfaceChanged: {
        worktreeId: target.surface.worktreeId,
        surfaceId: target.surface.id,
        change: deleted.deletedSurfaceId === target.surface.id ? 'deleted' : 'pane_deleted',
        deletedPaneIds: [...deleted.deletedPaneIds],
      },
    });
    return {
      deletedSurfaceId: deleted.deletedSurfaceId,
      deletedPaneIds: [...deleted.deletedPaneIds],
    } satisfies DeleteSurfaceOutput;
  });
}

/**
 * Everything after the placement removal has committed.
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
    readonly sessions: {
      readonly agents: readonly AgentSessionRow[];
      readonly terminals: readonly TerminalSessionRow[];
    };
    readonly deletedPanes: readonly SurfacePaneRow[];
    readonly editorContextIds: readonly number[];
    readonly held: EntityLockHeld | null;
    readonly surfaceChanged: SurfaceChangedEvent['payload'];
  },
) {
  const cleanup = Effect.gen(function* () {
    // Agents and terminals only. An editor is never routed through this helper:
    // it is best-effort inside a `catchAll`, and clearing an editor's ownership
    // requires the affirmative outcome that discards.
    yield* terminateDeletedPanePtys(deps.pty, args.sessions);
    const { held } = args;
    if (!held) return;
    for (const editorContextId of args.editorContextIds) {
      // Read through the surfaces repository, by the surfaces layer: handing the
      // editor domain a pane read to answer a question about itself would
      // reopen the cycle the one-way dependency exists to prevent.
      const placement = yield* deps.repository.findPaneForSession({
        sessionKind: 'editor_context',
        sessionId: editorContextId,
      });
      // Re-placed or bound elsewhere while we held the lock: never terminate.
      if (placement) continue;
      yield* deps.editors.releaseIncarnation({ held, editorContextId });
    }
  });
  const publications = Effect.gen(function* () {
    yield* publishDeletedPaneSessionChanges(deps.eventBus, args.deletedPanes);
    yield* publishSurfaceChanged(deps.eventBus, args.surfaceChanged);
  });
  return cleanup.pipe(Effect.ensuring(publications));
}

function sessionsForPaneIds(repository: SurfaceRepositoryService, paneIds: readonly number[]) {
  return Effect.all({
    agents: repository.listAgentSessionsForPanes(paneIds),
    terminals: repository.listTerminalSessionsForPanes(paneIds),
  });
}

function terminateDeletedPanePtys(
  pty: PtyServiceShape,
  sessions: {
    readonly agents: readonly AgentSessionRow[];
    readonly terminals: readonly TerminalSessionRow[];
  },
) {
  return terminatePtyProcessIds(pty, {
    failurePolicy: 'best_effort',
    gracefulTimeoutMs: 1_000,
    operation: 'surface_delete',
    ptyProcessIds: activePtyProcessIdsForSessions(sessions),
  }).pipe(Effect.catchAll(() => Effect.void));
}

function publishSurfaceChanged(
  eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService,
  payload: import('@isagi/contracts').SurfaceChangedEvent['payload'],
) {
  return eventBus.publish({ type: 'surface_changed', payload });
}

function publishDeletedPaneSessionChanges(
  eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService,
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
  eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService,
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
  eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService,
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
  },
  pane: SurfacePaneRow,
): SurfaceDetail['panes'][number]['session'] {
  const { agentSessions, terminalSessions, editorContexts, readiness } = sources;
  if (pane.sessionKind === 'agent_session' && pane.sessionId !== null) {
    const agent = agentSessions.find((candidate) => candidate.id === pane.sessionId);
    if (!agent) return null;
    const state = deriveAgentSessionState(agent);
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

function setWorktreeEnvironmentFocus(
  repository: SurfaceRepositoryService,
  input: { readonly worktreeId: number; readonly focus: SetWorktreeEnvironmentFocusInput },
) {
  return Effect.gen(function* () {
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
}

function decodeLayout(layoutJson: string): SurfaceLayoutNode {
  return Schema.decodeUnknownSync(surfaceLayoutNodeSchema)(JSON.parse(layoutJson));
}
