import { Context, Data, Effect, Layer, Schema } from 'effect';

import type {
  CreateSurfaceOutput,
  DeleteSurfaceOutput,
  PaneSessionClaimInput,
  PaneSessionClaimOutput,
  PaneSessionCreateInput,
  PaneSessionSpec,
  RenameSurfaceOutput,
  SetSplitWeightsInput,
  SetSplitWeightsOutput,
  SetWorktreeEnvironmentFocusInput,
  SplitPaneInput,
  SurfaceDetail,
  SurfaceLayoutNode,
  WorktreeEnvironmentFocusOutput,
} from '@isagi/contracts';
import { surfaceLayoutNodeSchema } from '@isagi/contracts';

import { displayNameForHarness } from '../agent-sessions/harness/display.js';
import { HarnessAdapterError } from '../agent-sessions/harness/types.js';
import { AgentSessionError, AgentSessionService } from '../agent-sessions/index.js';
import type { DatabaseError } from '../persistence/index.js';
import type { PtyLaunchError } from '../pty-processes/pty.service.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SessionLifecycle } from '../session-lifecycle/index.js';
import { TerminalSessionError, TerminalSessionService } from '../terminal-sessions/index.js';
import { planSurfacePaneDelete } from './delete-plan.js';
import { setNodeWeights } from './layout.js';
import { deriveAgentSessionState, deriveTerminalSessionState } from './session-status.js';
import { SurfaceRepository, type SurfaceRepositoryService } from './surfaces.repository.js';
import type {
  AgentSessionRow,
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  SurfacePaneRow,
  TerminalSessionRow,
} from './types.js';

export class SurfaceError extends Data.TaggedError('SurfaceError')<{
  readonly code:
    | 'surface_not_found'
    | 'worktree_not_found'
    | 'pane_not_found'
    | 'session_not_found'
    | 'session_worktree_mismatch'
    | 'invalid_surface_title'
    | 'layout_node_stale';
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly paneId?: number | undefined;
  readonly sessionId?: number | undefined;
}> {}

export type SurfaceServiceError = DatabaseError | SurfaceError;
type PaneSessionClaimError = SurfaceServiceError | PtyLaunchError | HarnessAdapterError;

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
}

export const SurfaceService = Context.GenericTag<SurfaceService>('isagi/SurfaceService');

export const SurfaceServiceLive = Layer.effect(
  SurfaceService,
  Effect.gen(function* () {
    const repository = yield* SurfaceRepository;
    const agents = yield* AgentSessionService;
    const terminals = yield* TerminalSessionService;
    const lifecycle = yield* SessionLifecycle;
    const eventBus = yield* InternalRuntimeEventBus;

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
          const [agentSessions, terminalSessions] = yield* Effect.all([
            repository.listAgentSessionsForPanes(paneIds),
            repository.listTerminalSessionsForPanes(paneIds),
          ]);
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
              session: sessionForPane(agentSessions, terminalSessions, pane),
            })),
          } satisfies SurfaceDetail;
        }),
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
          return yield* repository.renameSurface({ surfaceId: input.surfaceId, title });
        }),
      deleteSurface: (surfaceId) =>
        Effect.gen(function* () {
          const target = yield* loadDeleteTarget(repository, surfaceId);
          const deleted = yield* repository.deleteSurface(target);
          yield* publishDeletedPaneSessionChanges(
            eventBus,
            target.panes.map(({ pane }) => pane),
          );
          return {
            deletedSurfaceId: deleted.deletedSurfaceId,
            deletedPaneIds: [...deleted.deletedPaneIds],
          } satisfies DeleteSurfaceOutput;
        }),
      deleteSurfacePane: (input) =>
        Effect.gen(function* () {
          const target = yield* loadDeleteTarget(repository, input.surfaceId);
          const paneTarget = target.panes.find(({ pane }) => pane.id === input.paneId);
          if (!paneTarget)
            return yield* Effect.fail(
              new SurfaceError({
                code: 'pane_not_found',
                message: `Pane ${input.paneId} was not found for surface ${input.surfaceId}.`,
                surfaceId: input.surfaceId,
                paneId: input.paneId,
              }),
            );
          const plan = planSurfacePaneDelete(target, input.paneId);
          const deleted = yield* repository.deleteSurfacePane({ target, plan });
          const deletedPanes = target.panes
            .map(({ pane }) => pane)
            .filter((pane) => deleted.deletedPaneIds.includes(pane.id));
          yield* publishDeletedPaneSessionChanges(eventBus, deletedPanes);
          return {
            deletedSurfaceId: deleted.deletedSurfaceId,
            deletedPaneIds: [...deleted.deletedPaneIds],
          } satisfies DeleteSurfaceOutput;
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
          return yield* repository.setSurfaceLayout({
            surfaceId: input.surfaceId,
            layout: nextLayout,
          });
        }),
      createPaneSession: (input) =>
        createPaneSession(
          repository,
          agents,
          terminals,
          lifecycle,
          eventBus,
          input.worktreeId,
          input.create,
        ),
      claimPaneSession: (input) =>
        claimPaneSession(
          repository,
          agents,
          terminals,
          lifecycle,
          eventBus,
          input.worktreeId,
          input.claim,
        ),
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
          return yield* repository.createSinglePaneSurface(input);
        }),
      setWorktreeEnvironmentFocus: (input) => setWorktreeEnvironmentFocus(repository, input),
    } satisfies SurfaceService;
  }),
);

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
  if (
    !pane.sessionKind ||
    !pane.sessionId ||
    (pane.sessionKind === next.kind && pane.sessionId === next.sessionId)
  ) {
    return Effect.void;
  }
  return publishSessionChanged(eventBus, pane.sessionKind, pane.sessionId);
}

function publishSessionChanged(
  eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService,
  sessionKind: 'agent_session' | 'terminal_session',
  sessionId: number,
) {
  return eventBus.publish(
    sessionKind === 'agent_session'
      ? { type: 'agent_session_changed', agentSessionId: sessionId }
      : { type: 'terminal_session_changed', terminalSessionId: sessionId },
  );
}

function sessionForPane(
  agentSessions: readonly AgentSessionRow[],
  terminalSessions: readonly TerminalSessionRow[],
  pane: SurfacePaneRow,
): SurfaceDetail['panes'][number]['session'] {
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
