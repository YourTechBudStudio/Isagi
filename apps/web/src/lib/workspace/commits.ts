/**
 * Workspace commit paths: what the client does after a runtime write so the screen, the selection
 * and the terminal cache agree with the runtime again.
 *
 * Every export is an app effect (`AppRequirements`): palette commands run them with `ctx.app`,
 * React handlers with `useAppRun()`, tests with `runApp(registry, ...)`. The bodies keep the old
 * order of steps. Mapping from the React Query versions (web-state §3.1):
 *
 * - a read-after-write (`fetchQuery({ staleTime: 0 })`, `cancelQueries` + `fetchQuery`) is
 *   `refreshWorkspace()`: the in-flight read is cancelled and the answer comes from a single read
 *   attempt that began after the write (as `fetchQuery`, it does not retry), so it is strictly
 *   causal everywhere;
 * - an awaited `invalidateQueries` is `revalidate(query)` (refetch and wait, only if held);
 * - writes are `Effect.uninterruptible`, so nothing aborts a request that reached the runtime.
 */
import { Cause, Effect, Exit } from 'effect';
import { Atom, AtomRegistry } from 'effect/reactivity';

import type {
  AgentHarness,
  CreateSurfaceOutput,
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  DeletePaneOutput,
  DeleteSurfaceOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  ReconciliationFinding,
  SetSplitWeightsInput,
  SetSplitWeightsOutput,
  SplitPaneInput,
  StartPaneInput,
} from '@isagi/contracts';

import { toastCopy } from '../../copy/index.js';
import { makeLatestWins, sessionObject } from '../state/channel.js';
import { patch, revalidate } from '../state/policy.js';
import type { AppRequirements } from '../state/runtime.js';
import { showToast } from '../toast/index.js';
import {
  activatePane,
  activateSurface,
  cancelWorkbenchFocusPersistence,
  restoreActivePaneFocus,
} from './activation.js';
import { handleReconciliationFindings, scheduleWorkspaceReconcile } from './background-sync.js';
import { defaultSelection, findWorktree, reconcileSelection } from './model.js';
import {
  cachedWorkspaceData,
  refreshWorkspace,
  revalidateCommandReadModel,
  surfaceDetailAtom,
  workspaceReadAtom,
} from './queries.js';
import {
  addProject,
  deleteProject,
  deleteSurface,
  deleteSurfacePane,
  deleteWorktree,
  formatRuntimeError,
  launchAgentSession,
  launchTerminalSession,
  openWorktree,
  reconcileWorkspace,
  relocateProject,
  renameSurfaceTitle,
  runCommand,
  setSplitWeights,
  splitPane,
  startPane,
} from './runtime-data.js';
import {
  activeSurfaceByWorktreeAtom,
  forgetPane,
  forgetSurface,
  selectionAtom,
  selectWorktree,
  setSelection,
} from './store.js';
import { publishTerminalFactEffect } from './terminal-presentation/facts.js';

/** The app registry, from the effect context (`runApp` and atom effects provide it). */
const registryNow = AtomRegistry.AtomRegistry;

/**
 * Re-read the held workspace and wait for it (the old awaited `invalidateQueries`); when nothing
 * holds the workspace there is nothing to re-read. A failed re-read is not the caller's failure.
 */
const revalidateWorkspace = () => revalidate(workspaceReadAtom);

// --- Project recheck ----------------------------------------------------------------------------

/**
 * What a same-path recheck established about one project.
 *
 * There is deliberately no `failed` member. A check that could not be completed
 * produces *no* result at all — the operation fails — so the surface can never
 * report an absence on evidence it does not have. The three outcomes the user
 * must be able to tell apart (restored, confirmed still unavailable, and "we
 * could not find out") are therefore distinct by construction rather than
 * inferred from a flag.
 *
 * `projectId` names the operation's target. It stays independent of whichever
 * project the UI happens to be showing when the answer arrives.
 */
export type ProjectRecheckResult =
  | { readonly status: 'restored'; readonly projectId: number }
  | { readonly status: 'still_unavailable'; readonly projectId: number };

/**
 * Look again at a folder project's own path, and answer with what a *fresh*
 * snapshot says.
 *
 * A folder project cannot be relocated, so the only honest recovery is to
 * reconcile the project the user is looking at and then read the workspace
 * back. Three properties make the answer trustworthy, and all three are easy to
 * lose:
 *
 * 1. **The refresh is an awaited read that can fail.** A reconcile that restored
 *    the folder followed by a failed read must not resolve against stale
 *    missing-project data and be reported as "Still not there"; the read's
 *    failure is the operation's failure.
 * 2. **The read cannot be an older one.** The workspace refetches on window
 *    focus and after active-context persistence, so a read started *before* the
 *    reconcile committed is an ordinary thing to have in flight when this runs.
 *    `refreshWorkspace` cancels it (its answer can then never land) and waits for
 *    a read that began after this call.
 * 3. **The findings are not evidence.** An empty findings list is returned both
 *    when nothing changed and when the project was already present, so the
 *    reconcile result is discarded. The verdict comes from the snapshot.
 *
 * The guarantee this buys is *causal*, not durable: the read began after the
 * reconcile completed, so it reflects that reconcile's work. It does not promise
 * the folder is still there by the time the user reads the answer.
 *
 * Selection is never written here. A restored project reaches its environment
 * through the ordinary refreshed-snapshot path (`useWorkspaceSelectionSync` →
 * `reconcileSelection`), which is what keeps a newer selection made while this
 * was in flight from being overwritten.
 *
 * Findings are deliberately not routed to toasts. This is a user action, so its
 * result belongs at the surface that started it (ADR 0004).
 */
export const runProjectRecheck = Effect.fn('runProjectRecheck')(function* (projectId: number) {
  yield* Effect.asVoid(reconcileWorkspace({ projectId }));
  const data = yield* refreshWorkspace();
  yield* publishTerminalFactEffect({ type: 'durable_inventory_refresh_requested' });
  const project = data.projects.find((candidate) => candidate.id === projectId);
  return project && project.status !== 'missing'
    ? ({ status: 'restored', projectId } as const)
    : ({ status: 'still_unavailable', projectId } as const);
});

// --- Palette operations ---------------------------------------------------------------------------

export const addProjectPath = Effect.fn('addProjectPath')(function* (path: string) {
  const output = yield* Effect.uninterruptible(addProject(path));
  yield* commitAddProjectSuccess({ projectId: output.projectId });
});

export const relocateProjectPath = Effect.fn('relocateProjectPath')(function* (
  projectId: number,
  path: string,
) {
  const output = yield* Effect.uninterruptible(relocateProject(projectId, path));
  yield* commitRelocateProjectSuccess(output.findings);
});

export const openWorktreeFromPalette = Effect.fn('openWorktreeFromPalette')(function* (
  projectId: number,
  input: OpenWorktreeInput,
) {
  const output = yield* Effect.uninterruptible(openWorktree(projectId, input));
  yield* commitOpenWorktreeSuccess(output);
  return output;
});

export const deleteWorktreeFromPalette = Effect.fn('deleteWorktreeFromPalette')(
  function* (projectId: number, worktreeId: number, input: DeleteWorktreeInput) {
    const output = yield* Effect.uninterruptible(deleteWorktree(projectId, worktreeId, input));
    yield* commitDeleteWorktreeSuccess(output);
    return output;
  },
  Effect.onError(() => revalidateWorkspace()),
);

/**
 * The one project-delete path, shared by every entry point through the
 * `delete-project` palette command. Never fails: a failure is reported by the
 * existing toast and the snapshot is re-read, so the palette can always close.
 * `{ deleted: false }` (already gone) is success.
 */
export const deleteProjectFromPalette = Effect.fn('deleteProjectFromPalette')(function* (
  projectId: number,
) {
  const registry = yield* registryNow;
  const removed = yield* Effect.exit(Effect.uninterruptible(deleteProject(projectId)));
  if (Exit.isFailure(removed)) {
    const error = Cause.squash(removed.cause);
    showToast(registry, {
      id: `delete-project-failed:${projectId}`,
      kind: 'warning',
      title: toastCopy.projectDeleteFailed.title,
      subtitle: formatRuntimeError(error),
    });
    yield* Effect.logError('[workspace] project deletion failed', error);
    yield* revalidateWorkspace();
    return;
  }
  const committed = yield* Effect.exit(commitDeleteProjectSuccess(projectId));
  if (Exit.isFailure(committed)) {
    // The project is gone; only the follow-up read failed. Saying the delete
    // failed would be false, so log it and let the next refetch catch up.
    yield* Effect.logError(
      '[workspace] workspace refresh after project deletion failed',
      Cause.squash(committed.cause),
    );
    yield* revalidateWorkspace();
  }
});

export const startAgentSessionFromPalette = Effect.fn('startAgentSessionFromPalette')(
  function* (worktreeId: number, harness: AgentHarness) {
    const output = yield* Effect.uninterruptible(launchAgentSession(worktreeId, harness));
    yield* commitLaunchSessionSuccess(output);
    return output;
  },
  Effect.onError(() => commitLaunchSessionFailure()),
);

export const startTerminalSessionFromPalette = Effect.fn('startTerminalSessionFromPalette')(
  function* (worktreeId: number) {
    const output = yield* Effect.uninterruptible(launchTerminalSession(worktreeId));
    yield* commitLaunchSessionSuccess(output);
    return output;
  },
);

/** Starts the first pane of an empty surface, then settles like any new placement. */
export const startPaneFromPalette = Effect.fn('startPaneFromPalette')(function* (
  surfaceId: number,
  newPane: StartPaneInput['newPane'],
) {
  const settled = Effect.gen(function* () {
    const output = yield* Effect.uninterruptible(startPane(surfaceId, { newPane }));
    yield* revalidate(surfaceDetailAtom(surfaceId));
    yield* commitLaunchSessionSuccess(output);
    return output;
  });
  return yield* settled.pipe(
    Effect.onError(() =>
      Effect.andThen(revalidate(surfaceDetailAtom(surfaceId)), commitLaunchSessionFailure()),
    ),
  );
});

/**
 * Launch a configured command from a palette row. The catalog and the command's
 * log metadata are re-read on both outcomes, the same settle semantics
 * `commandActionAtoms` give the drawer. The endpoint's output is returned
 * unchanged; the palette ignores it and hands off to the drawer, which is the
 * surface that owns run diagnostics.
 */
export const runConfiguredCommandFromPalette = Effect.fn('runConfiguredCommandFromPalette')(
  function* (worktreeId: number, commandName: string) {
    return yield* Effect.uninterruptible(runCommand(worktreeId, commandName)).pipe(
      Effect.ensuring(revalidateCommandReadModel(worktreeId, commandName)),
    );
  },
);

export const renameSurfaceTitleFromPalette = Effect.fn('renameSurfaceTitleFromPalette')(
  function* (surfaceId: number, title: string) {
    const output = yield* Effect.uninterruptible(renameSurfaceTitle(surfaceId, title));
    yield* commitRenameSurfaceSuccess(output.surfaceId);
    return output;
  },
  Effect.onError(() => revalidateWorkspace()),
);

export const deleteSurfaceFromPalette = Effect.fn('deleteSurfaceFromPalette')(
  function* (input: { readonly worktreeId: number; readonly surfaceId: number }) {
    // Decided before the request: the runtime's `surface_changed` event can forget the active
    // override and re-read the workspace before the response lands, erasing both facts.
    const successorSurfaceId = surfaceSuccessor(yield* registryNow, input);
    const output = yield* Effect.uninterruptible(deleteSurface(input.surfaceId));
    yield* commitDeleteSurfaceSuccess({
      worktreeId: input.worktreeId,
      surfaceId: input.surfaceId,
      output,
      successorSurfaceId,
    });
    return output;
  },
  Effect.onError(() => revalidateWorkspace()),
);

export const deleteSurfacePaneFromPalette = Effect.fn('deleteSurfacePaneFromPalette')(
  function* (input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly paneId: number;
  }) {
    const output = yield* Effect.uninterruptible(deleteSurfacePane(input.surfaceId, input.paneId));
    yield* commitDeletePaneSuccess({ ...input, output });
    return output;
  },
  Effect.onError(() => revalidateWorkspace()),
);

export const splitPaneFromPalette = Effect.fn('splitPaneFromPalette')(function* (input: {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly split: SplitPaneInput;
}) {
  const settled = Effect.gen(function* () {
    const output = yield* Effect.uninterruptible(splitPane(input.worktreeId, input.split));
    yield* commitSplitPaneSuccess(output);
    return output;
  });
  return yield* settled.pipe(
    Effect.onError(() =>
      Effect.andThen(revalidateWorkspace(), revalidate(surfaceDetailAtom(input.surfaceId))),
    ),
  );
});

// --- Split weights ------------------------------------------------------------------------------

/**
 * A resize commit returns the whole surface layout, so an older response landing
 * after a newer one would revert the newer resize. Each commit claims its surface
 * and only the latest one touches the cache: stale successes are dropped and a
 * stale failure does not force a refetch that would clobber a newer commit. The
 * server stays authoritative and refetch-on-focus backstops any dropped write.
 */
export const splitWeightCommitsAtom = sessionObject(() => makeLatestWins<number>());

export type SplitWeightsCommit = (
  surfaceId: number,
  weights: SetSplitWeightsInput,
) => Effect.Effect<SetSplitWeightsOutput, Error, AppRequirements>;

export const setSplitWeightsFromSurface = Effect.fn('setSplitWeightsFromSurface')(
  function* (input: {
    readonly surfaceId: number;
    readonly weights: SetSplitWeightsInput;
    /** Test seam; production persists through the runtime. */
    readonly commit?: SplitWeightsCommit | undefined;
  }) {
    const registry = yield* registryNow;
    const commit = input.commit ?? setSplitWeights;
    const isLatest = (yield* Atom.get(splitWeightCommitsAtom)).claim(input.surfaceId);
    const exit = yield* Effect.exit(Effect.uninterruptible(commit(input.surfaceId, input.weights)));
    if (Exit.isSuccess(exit)) {
      const output = exit.value;
      if (isLatest()) {
        patch(registry, surfaceDetailAtom(output.surfaceId), (detail) => ({
          ...detail,
          layout: output.layout,
        }));
      }
      return output;
    }
    if (isLatest()) {
      yield* revalidate(surfaceDetailAtom(input.surfaceId));
    }
    return yield* Effect.failCause(exit.cause);
  },
);

// --- Commits --------------------------------------------------------------------------------------

export const commitOpenWorktreeSuccess = Effect.fn('commitOpenWorktreeSuccess')(function* (
  output: OpenWorktreeOutput,
) {
  yield* refreshWorkspace();
  const registry = yield* registryNow;
  selectWorktree(registry, output.projectId, output.worktreeId);
  restoreActivePaneFocus(registry);
  // A setup-hook failure (status 'created_setup_failed') is surfaced as a
  // palette-local warning result by the open-worktree command, not here — the
  // worktree still exists and is selected above.
});

/**
 * Where a newly placed pane lives — the least a settle needs to fetch the
 * snapshot and activate it.
 *
 * `CreateSurfaceOutput` is structurally assignable to this, so every session
 * caller is unchanged. Opening an editor answers with a bare placement and no
 * title: placement is the operation's answer, and a title would be a second
 * naming authority over a surface the runtime already named.
 */
export interface SurfacePlacement {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId: number;
}

export const commitLaunchSessionSuccess = Effect.fn('commitLaunchSessionSuccess')(function* (
  output: SurfacePlacement,
) {
  yield* refreshWorkspace();
  activatePane(
    yield* registryNow,
    { worktreeId: output.worktreeId, surfaceId: output.surfaceId, paneId: output.paneId },
    { persist: false },
  );
});

export const commitLaunchSessionFailure = Effect.fn('commitLaunchSessionFailure')(function* () {
  yield* revalidateWorkspace();
});

export const commitSplitPaneSuccess = Effect.fn('commitSplitPaneSuccess')(function* (
  output: CreateSurfaceOutput,
) {
  yield* revalidate(surfaceDetailAtom(output.surfaceId));
  yield* revalidateWorkspace();
  activatePane(
    yield* registryNow,
    { worktreeId: output.worktreeId, surfaceId: output.surfaceId, paneId: output.paneId },
    { persist: false },
  );
});

export const commitRenameSurfaceSuccess = Effect.fn('commitRenameSurfaceSuccess')(function* (
  surfaceId: number,
) {
  yield* revalidateWorkspace();
  yield* revalidate(surfaceDetailAtom(surfaceId));
});

/**
 * The surface to activate when `target` goes: its next rail neighbour, else the previous one. `null`
 * when `target` is not the worktree's active surface (deleting another one keeps the selection) or
 * is its only surface.
 */
function surfaceSuccessor(
  registry: AtomRegistry.AtomRegistry,
  target: { readonly worktreeId: number; readonly surfaceId: number },
): number | null {
  const worktree = findWorktree(cachedWorkspaceData(registry)?.projects ?? [], target.worktreeId);
  if (!worktree) return null;
  const activeSurfaceId =
    registry.get(activeSurfaceByWorktreeAtom)[target.worktreeId] ?? worktree.activeSurfaceId;
  if (activeSurfaceId !== target.surfaceId) return null;
  const index = worktree.surfaces.findIndex((surface) => surface.id === target.surfaceId);
  if (index === -1) return null;
  return (worktree.surfaces[index + 1] ?? worktree.surfaces[index - 1])?.id ?? null;
}

/**
 * The deleted surface's detail stays cached but is never read again (web-state §2.3 delta 5:
 * there is no `removeQueries`); the local overrides and the focus revision are what matter.
 *
 * Deleting the active surface activates `successorSurfaceId` (persisting the runtime focus row,
 * whose `active_surface_id` the delete nulled), unless the user activated another surface meanwhile
 * or the successor is gone too.
 */
export const commitDeleteSurfaceSuccess = Effect.fn('commitDeleteSurfaceSuccess')(
  function* (input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly output: DeleteSurfaceOutput;
    readonly successorSurfaceId: number | null;
  }) {
    const data = yield* refreshWorkspace();
    if (input.output.deletedSurfaceId !== input.surfaceId) return;
    const registry = yield* registryNow;
    yield* publishTerminalFactEffect({
      type: 'placement_removed',
      worktreeId: input.worktreeId,
      surfaceId: input.surfaceId,
    });
    cancelWorkbenchFocusPersistence(registry, input.worktreeId);
    forgetSurface(registry, input.worktreeId, input.surfaceId);
    forgetPane(registry, input.surfaceId);
    const successor = findWorktree(data.projects, input.worktreeId)?.surfaces.find(
      (surface) => surface.id === input.successorSurfaceId,
    );
    if (successor && registry.get(activeSurfaceByWorktreeAtom)[input.worktreeId] === undefined) {
      activateSurface(registry, { worktreeId: input.worktreeId, surfaceId: successor.id });
    }
  },
);

/**
 * A pane delete never removes its surface: the last pane going leaves the
 * surface empty, still selected, showing its empty state.
 */
export const commitDeletePaneSuccess = Effect.fn('commitDeletePaneSuccess')(function* (input: {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId: number;
  readonly output: DeletePaneOutput;
}) {
  yield* refreshWorkspace();
  yield* publishTerminalFactEffect({
    type: 'placement_removed',
    worktreeId: input.worktreeId,
    surfaceId: input.surfaceId,
    paneId: input.paneId,
  });
  forgetPane(yield* registryNow, input.surfaceId, input.paneId);
  yield* revalidate(surfaceDetailAtom(input.surfaceId));
});

export const commitDeleteWorktreeSuccess = Effect.fn('commitDeleteWorktreeSuccess')(function* (
  output: DeleteWorktreeOutput,
) {
  yield* publishTerminalFactEffect({
    type: 'durable_worktree_deleted',
    worktreeId: output.deletedWorktreeId,
  });
  const data = yield* refreshWorkspace();
  const registry = yield* registryNow;

  const project = data.projects.find((candidate) => candidate.id === output.projectId);
  const selected = project?.worktrees.find(
    (candidate) => candidate.id === output.selectedWorktreeId,
  );
  if (project && selected) {
    selectWorktree(registry, project.id, selected.id);
    restoreActivePaneFocus(registry);
    return;
  }

  setSelection(
    registry,
    reconcileSelection(data.projects, {
      kind: 'worktree',
      projectId: output.projectId,
      worktreeId: output.selectedWorktreeId,
    }),
  );
  restoreActivePaneFocus(registry);
});

export const commitAddProjectSuccess = Effect.fn('commitAddProjectSuccess')(function* (
  options: { readonly projectId?: number | null; readonly reconcile?: boolean } = {},
) {
  yield* revalidateWorkspace();
  if (options.reconcile ?? true) {
    yield* scheduleWorkspaceReconcile(options.projectId ?? null);
  }
});

export const commitRelocateProjectSuccess = Effect.fn('commitRelocateProjectSuccess')(function* (
  findings: readonly ReconciliationFinding[],
) {
  handleReconciliationFindings(yield* registryNow, findings);
  yield* revalidateWorkspace();
});

/**
 * Settle a successful project delete.
 *
 * The worktree ids come from the cache *before* the refetch replaces it, since
 * the fresh snapshot no longer knows them. The selection is moved here, before
 * `useWorkspaceSelectionSync` sees the new data: left to that effect, a worktree
 * selection on the deleted project would be "recovered" with a warning that the
 * checkout is no longer reported by Git, which is false for a deliberate delete.
 * A selection elsewhere is left alone.
 *
 * The read must begin after the delete: a workspace read already in flight (a
 * focus refetch, say) would still list the deleted project. `refreshWorkspace`
 * cancels it and waits for a read that began after this call.
 */
export const commitDeleteProjectSuccess = Effect.fn('commitDeleteProjectSuccess')(function* (
  projectId: number,
) {
  const registry = yield* registryNow;
  const worktreeIds =
    cachedWorkspaceData(registry)
      ?.projects.find((project) => project.id === projectId)
      ?.worktrees.map((worktree) => worktree.id) ?? [];
  for (const worktreeId of worktreeIds) {
    yield* publishTerminalFactEffect({ type: 'durable_worktree_deleted', worktreeId });
  }

  const data = yield* refreshWorkspace();

  const selection = registry.get(selectionAtom);
  if (
    (selection.kind === 'worktree' || selection.kind === 'missingProject') &&
    selection.projectId === projectId
  ) {
    setSelection(registry, defaultSelection(data.projects));
    restoreActivePaneFocus(registry);
  }
  yield* publishTerminalFactEffect({ type: 'durable_inventory_refresh_requested' });
});
