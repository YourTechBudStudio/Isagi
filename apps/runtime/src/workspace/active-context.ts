import { Effect } from 'effect';

import type {
  ActiveContext,
  ActiveContextOutput,
  ActiveContextPersistenceInput,
} from '@isagi/contracts';

import { InternalEvents } from '../platform/events/index.js';
import { ProjectRepository } from '../projects/index.js';
import { WorkspaceError } from './errors.js';
import { StateFile, type WorkspaceState } from './state-file.js';

/**
 * The active project and worktree, persisted in `state.json`.
 *
 * Active context is frontend-owned restoration state: the runtime stores the latest revision a client wrote, refuses
 * a target that does not exist, and announces a change of active worktree to the modules that act on it. Stale
 * references left behind by deletions are reconciled by the frontend, never cleared here.
 */
export const activeContext = Effect.gen(function* () {
  const repository = yield* ProjectRepository;
  const stateFile = yield* StateFile;
  const internalEvents = yield* InternalEvents;

  const validateTarget = Effect.fnUntraced(function* (
    requested: ActiveContextPersistenceInput['activeContext'],
  ) {
    if (requested.projectId === null) {
      return { projectId: null, worktreeId: null } satisfies ActiveContext;
    }

    const project = yield* repository.findProject(requested.projectId);
    if (!project) {
      return yield* new WorkspaceError({
        code: 'project_not_found',
        message: `Project ${requested.projectId} was not found.`,
        projectId: requested.projectId,
      });
    }
    if (project.status !== 'present') {
      return yield* new WorkspaceError({
        code: 'project_not_present',
        message: `Project ${requested.projectId} is not present.`,
        projectId: requested.projectId,
      });
    }

    const worktree = yield* repository.findWorktree(requested.worktreeId);
    if (!worktree || worktree.projectId !== requested.projectId) {
      return yield* new WorkspaceError({
        code: 'worktree_not_found',
        message: `Worktree ${requested.worktreeId} was not found for project ${requested.projectId}.`,
        projectId: requested.projectId,
        worktreeId: requested.worktreeId,
      });
    }

    return requested;
  });

  return {
    getActiveContext: stateFile.read.pipe(
      Effect.map((state): ActiveContextOutput => ({
        activeContext: activeContextFromState(state),
      })),
      Effect.withSpan('WorkspaceService.getActiveContext'),
    ),
    setActiveContext: Effect.fn('WorkspaceService.setActiveContext')(function* (
      input: ActiveContextPersistenceInput,
    ) {
      const state = yield* stateFile.read;
      if (input.revision <= state.workspace.activeContextRevision) {
        return { activeContext: activeContextFromState(state) } satisfies ActiveContextOutput;
      }

      const accepted = yield* validateTarget(input.activeContext);

      const nextState = yield* stateFile.writeActiveContextIfFresh({
        activeProjectId: accepted.projectId,
        activeWorktreeId: accepted.worktreeId,
        revision: input.revision,
      });
      const previousWorktreeId = state.workspace.activeWorktreeId;
      const nextWorktreeId = nextState.workspace.activeWorktreeId;
      if (
        nextState.workspace.activeContextRevision === input.revision &&
        previousWorktreeId !== nextWorktreeId
      ) {
        yield* internalEvents.publish({
          type: 'worktree_activation_change',
          previousWorktreeId,
          nextWorktreeId,
          cause: 'active_context_changed',
        });
      }
      return { activeContext: activeContextFromState(nextState) } satisfies ActiveContextOutput;
    }),
    publishRestoredActivation: Effect.gen(function* () {
      const state = yield* stateFile.read;
      const worktreeId = state.workspace.activeWorktreeId;
      const worktree = worktreeId === null ? null : yield* repository.findWorktree(worktreeId);
      // Published even with no active worktree: startup work that is not tied
      // to the active one, such as resuming keep-alive commands, rides it too.
      yield* internalEvents.publish({
        type: 'worktree_activation_change',
        previousWorktreeId: null,
        nextWorktreeId: worktree?.id ?? null,
        cause: 'startup_restored',
      });
    }).pipe(Effect.withSpan('WorkspaceService.publishRestoredActivation')),
  };
});

function activeContextFromState(state: WorkspaceState): ActiveContext {
  if (state.workspace.activeProjectId === null) {
    return { projectId: null, worktreeId: null };
  }
  if (state.workspace.activeWorktreeId === null) {
    return { projectId: state.workspace.activeProjectId, worktreeId: null };
  }
  return {
    projectId: state.workspace.activeProjectId,
    worktreeId: state.workspace.activeWorktreeId,
  };
}
