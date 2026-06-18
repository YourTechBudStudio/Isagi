import { Context, Data, Effect, Layer, Schema } from 'effect';

import type {
  CreateSurfaceOutput,
  DeleteSurfaceOutput,
  LaunchAgentSurfaceInput,
  PaneSessionClaimInput,
  PaneSessionClaimOutput,
  PaneSessionCreateInput,
  RenameSurfaceOutput,
  SetWorktreeEnvironmentFocusInput,
  SurfaceDetail,
  SurfaceLayoutNode,
  WorktreeEnvironmentFocusOutput,
} from '@isagi/contracts';
import { surfaceLayoutNodeSchema } from '@isagi/contracts';

import {
  AgentSessionAttentionProjection,
  AgentSessionError,
  AgentSessionService,
} from '../agent-sessions/index.js';
import { displayNameForHarness, HarnessAdapterError } from '../harness-adapters/index.js';
import type { DatabaseError } from '../persistence/index.js';
import type { PtyLaunchError } from '../pty-processes/pty.service.js';
import { SessionLifecycle } from '../session-lifecycle/index.js';
import { TerminalSessionError, TerminalSessionService } from '../terminal-sessions/index.js';
import { planSurfacePaneDelete } from './delete-plan.js';
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
    | 'invalid_surface_title';
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
    readonly kind: 'agent' | 'terminal';
  }) => Effect.Effect<CreateSurfaceOutput, SurfaceServiceError>;
  readonly launchAgentSurface: (input: {
    readonly worktreeId: number;
    readonly launch: LaunchAgentSurfaceInput;
  }) => Effect.Effect<CreateSurfaceOutput, PaneSessionClaimError>;
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
    const attention = yield* AgentSessionAttentionProjection;

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
          const paneAttentions = yield* paneAttentionMap(
            attention,
            panes,
            agentSessions,
            terminalSessions,
          );
          const focus = yield* repository.findEnvironmentFocus(surface.worktreeId);
          const activePaneId = activePaneForSurface(surface.id, panes, focus);
          return {
            id: surface.id,
            worktreeId: surface.worktreeId,
            kind: surface.kind,
            title: surface.title,
            attention: aggregateAttention([...paneAttentions.values()]),
            layout: decodeLayout(surface.layoutJson),
            activePaneId,
            panes: panes.map((pane) => ({
              id: pane.id,
              surfaceId: pane.surfaceId,
              title: pane.title,
              attention: paneAttentions.get(pane.id) ?? 'idle',
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
          return {
            deletedSurfaceId: deleted.deletedSurfaceId,
            deletedPaneIds: [...deleted.deletedPaneIds],
          } satisfies DeleteSurfaceOutput;
        }),
      createSurface: (input) =>
        Effect.gen(function* () {
          const surface = yield* createSinglePaneSurface(repository, {
            worktreeId: input.worktreeId,
            kind: input.kind,
            titleBase: input.kind === 'agent' ? 'Agent' : 'Terminal',
          });
          return {
            worktreeId: input.worktreeId,
            surfaceId: surface.surfaceId,
            paneId: surface.paneId,
            title: surface.title,
          } satisfies CreateSurfaceOutput;
        }),
      launchAgentSurface: (input) =>
        Effect.gen(function* () {
          const surface = yield* createSinglePaneSurface(repository, {
            worktreeId: input.worktreeId,
            kind: 'agent',
            titleBase: displayNameForHarness(input.launch.harness),
          });
          yield* createPaneSession(repository, agents, terminals, lifecycle, input.worktreeId, {
            kind: 'agent_session',
            paneId: surface.paneId,
            harness: input.launch.harness,
          });
          return {
            worktreeId: input.worktreeId,
            surfaceId: surface.surfaceId,
            paneId: surface.paneId,
            title: surface.title,
          } satisfies CreateSurfaceOutput;
        }),
      createPaneSession: (input) =>
        createPaneSession(repository, agents, terminals, lifecycle, input.worktreeId, input.create),
      claimPaneSession: (input) =>
        claimPaneSession(repository, agents, terminals, lifecycle, input.worktreeId, input.claim),
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

function createPaneSession(
  repository: SurfaceRepositoryService,
  agents: import('../agent-sessions/index.js').AgentSessionServiceShape,
  terminals: import('../terminal-sessions/index.js').TerminalSessionServiceShape,
  lifecycle: import('../session-lifecycle/index.js').SessionLifecycleService,
  worktreeId: number,
  create: PaneSessionCreateInput,
): Effect.Effect<PaneSessionClaimOutput, PaneSessionClaimError> {
  return Effect.gen(function* () {
    const target = yield* loadPaneSessionTarget(repository, worktreeId, create.paneId);
    const session = yield* resolveCreatedSession(agents, terminals, worktreeId, target.cwd, create);
    return yield* assignPaneSession(repository, lifecycle, {
      worktreeId,
      surfaceId: target.surface.id,
      paneId: target.pane.id,
      session,
    });
  });
}

function claimPaneSession(
  repository: SurfaceRepositoryService,
  agents: import('../agent-sessions/index.js').AgentSessionServiceShape,
  terminals: import('../terminal-sessions/index.js').TerminalSessionServiceShape,
  lifecycle: import('../session-lifecycle/index.js').SessionLifecycleService,
  worktreeId: number,
  claim: PaneSessionClaimInput,
): Effect.Effect<PaneSessionClaimOutput, PaneSessionClaimError> {
  return Effect.gen(function* () {
    const target = yield* loadPaneSessionTarget(repository, worktreeId, claim.paneId);
    const session = yield* resolveClaimSession(agents, terminals, worktreeId, claim);
    return yield* assignPaneSession(repository, lifecycle, {
      worktreeId,
      surfaceId: target.surface.id,
      paneId: target.pane.id,
      session,
    });
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
  if (error.code === 'session_not_found')
    return new SurfaceError({
      code: 'session_not_found',
      message: error.message,
      worktreeId,
      sessionId,
    });
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

function paneAttentionMap(
  attention: import('../agent-sessions/index.js').AgentSessionAttentionProjectionService,
  panes: readonly SurfacePaneRow[],
  agentSessions: readonly AgentSessionRow[],
  terminalSessions: readonly TerminalSessionRow[],
) {
  return Effect.gen(function* () {
    const entries = yield* Effect.all(
      panes.map((pane) =>
        Effect.gen(function* () {
          if (pane.sessionKind === 'agent_session' && pane.sessionId !== null) {
            const agent = agentSessions.find((candidate) => candidate.id === pane.sessionId);
            return [
              pane.id,
              agent ? yield* attention.agentSessionAttention(agent) : 'error',
            ] as const;
          }
          if (pane.sessionKind === 'terminal_session' && pane.sessionId !== null) {
            const terminal = terminalSessions.find((candidate) => candidate.id === pane.sessionId);
            return [
              pane.id,
              terminal ? attention.terminalSessionAttention(terminal) : 'error',
            ] as const;
          }
          return [pane.id, 'idle'] as const;
        }),
      ),
    );
    return new Map(entries);
  });
}

function aggregateAttention(attentions: readonly import('@isagi/contracts').AttentionState[]) {
  if (attentions.includes('error')) return 'error';
  if (attentions.includes('waiting')) return 'waiting';
  if (attentions.includes('working')) return 'working';
  return 'idle';
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
