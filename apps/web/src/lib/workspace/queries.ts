import { useAtomValue } from '@effect/atom-react';
import { Duration, Effect, Option } from 'effect';
import { AsyncResult, Atom, AtomRegistry } from 'effect/reactivity';

import type { CommandActionOutput } from '@isagi/contracts';

import type { RuntimeApi } from '../runtime/client.js';
import { keys } from '../state/keys.js';
import {
  patch,
  peek,
  pollWhile,
  query,
  queryRetryAtom,
  revalidate,
  revalidationSignalAtom,
  type Query,
} from '../state/policy.js';
import { queryError } from '../state/result.js';
import { appRuntime } from '../state/runtime.js';
import * as commits from './commits.js';
import { workspaceDataFromSnapshot, type WorkspaceData } from './model.js';
import { projectRailOrder, railOrderAtom, type WorkspaceRead } from './rail-order-state.js';
import {
  fetchActiveContext,
  fetchCommandLogMetadata,
  fetchWorktreeCommands,
  fetchWorkspace,
  formatRuntimeError,
  getSurfaceDetail,
  restartCommand,
  runCommand,
  stopCommand,
} from './runtime-data.js';
import { publishTerminalFactEffect } from './terminal-presentation/facts.js';

// --- Workspace ------------------------------------------------------------------------------------
//
// The workspace is two atoms: `workspaceReadAtom` holds what the runtime answered,
// tagged with the rail clock at the moment each read began, and `workspaceAtom` is that read
// projected through `railOrderAtom` (pending and accepted-but-unconverged reorders). The cache never
// holds the projection, so a read can land at any time without erasing a move it did not know about.
// Every commit and hook reads the workspace through `workspaceAtom`, `cachedWorkspaceData` and
// `refreshWorkspace`; writes to the held read go through `patchWorkspaceData`.

/**
 * The runtime's workspace snapshot, decoded to the UI shape, with the rail clock at the moment the
 * read began (`get.once`: a rail change never re-reads). Default freshness policy, refreshed by
 * `keys.workspace` only (a workspace refresh does not re-read the active context).
 */
export const workspaceReadAtom = query(
  (get) => {
    const startedAt = get.once(railOrderAtom).clock;
    return fetchWorkspace().pipe(
      Effect.map((snapshot): WorkspaceRead => ({
        data: workspaceDataFromSnapshot(snapshot),
        startedAt,
      })),
    );
  },
  { keys: [keys.workspace] },
);

/**
 * What components display: the latest read with the rail's reorders on top (`projectRailOrder`).
 * A transform, so refreshing it refreshes the read and the freshness policy is the read's. A
 * failed refresh still shows the projected last success.
 */
export const workspaceAtom: Atom.Atom<AsyncResult.AsyncResult<WorkspaceData, Error>> =
  Atom.transform(workspaceReadAtom, (get) => {
    const rail = get(railOrderAtom);
    return AsyncResult.map(get(workspaceReadAtom), (read) => projectRailOrder(read, rail));
  });

/**
 * The workspace this session shows right now, without starting a read (the old
 * `getQueryData(workspaceQueryKey)`). Includes the last success under a failed refresh.
 */
export const cachedWorkspaceData = (
  registry: AtomRegistry.AtomRegistry,
): WorkspaceData | undefined => {
  const read = Option.getOrUndefined(
    Option.flatMap(peek(registry, workspaceReadAtom), AsyncResult.value),
  );
  return read === undefined ? undefined : projectRailOrder(read, registry.get(railOrderAtom));
};

/**
 * The old `setQueryData(workspaceQueryKey, update)` on a held success: rewrites the held read's data
 * and keeps the moment it began, so the rail keeps replaying exactly what that read could not know.
 */
export const patchWorkspaceData = (
  registry: AtomRegistry.AtomRegistry,
  update: (data: WorkspaceData) => WorkspaceData,
): void => patch(registry, workspaceReadAtom, (read) => ({ ...read, data: update(read.data) }));

/**
 * Read-after-write: cancel any workspace read in flight and answer with the workspace as shown on a
 * read that began after this call (fails if that read fails). Every commit that decides from the
 * snapshot uses this.
 */
export const refreshWorkspace = () =>
  Effect.flatMap(readFresh(workspaceReadAtom), (read) =>
    Effect.map(Atom.get(railOrderAtom), (rail) => projectRailOrder(read, rail)),
  );

/**
 * `refreshAndRead` as a single attempt: the old `fetchQuery({ staleTime: 0 })` never retried
 * (`fetchQuery` defaults `retry` to false), so a read-after-write that fails reports at once instead
 * of after the query's 1 s / 2 s / 4 s retries. The query's own reads keep their retry policy.
 *
 * The fresh read is built synchronously here with the registry's retry switch off (`query()` reads
 * `queryRetryAtom` once, when a read is built), then the switch is restored.
 */
export const readFresh = <A, E>(q: Query<A, E>) =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    const retry = registry.get(queryRetryAtom);
    registry.set(queryRetryAtom, null);
    try {
      registry.refresh(q);
      registry.get(q);
    } finally {
      registry.set(queryRetryAtom, retry);
    }
    return yield* Atom.getResult(q, { suspendOnWaiting: true });
  });

// --- Commands ---------------------------------------------------------------------------------------

/**
 * The worktree's configured-command catalog: the default freshness policy, refreshed by
 * `keys.commands(worktreeId)` only (the log metadata below has its own key, so invalidating the
 * catalog never touches it). The drawer and the status strip read this; the palette reads
 * {@link paletteCommandsAtom}, a stricter view on the same data. Select `disabledQuery` when no
 * worktree is active.
 */
export const worktreeCommandsAtom = Atom.family((worktreeId: number) =>
  query(() => fetchWorktreeCommands(worktreeId), { keys: [keys.commands(worktreeId)] }),
);

// Command membership is file-backed with no config-change event. Open-only
// polling bounds visible drift to ~10 s plus request latency; closing the
// palette unmounts this view, which stops the polling.
export const COMMAND_CATALOG_POLL_MS = 10_000;

/**
 * The palette's view of the catalog: polled every 10 s while the palette shows it, and re-read on
 * every focus or reconnect while it is open (a per-observer `staleTime: 0`). The drawer and status
 * strip keep the shared 10 s policy; this is a view on the same cache, not a second cache.
 *
 * The read on open is {@link readCommandsOnPaletteOpen}, not this view's mount: a mount
 * revalidation (`Atom.swr`) is deferred to the registry's low-priority scheduler and dropped if the
 * view unmounts first, so a palette opened and closed quickly would never read.
 */
export const paletteCommandsAtom = Atom.family((worktreeId: number) =>
  pollWhile(
    Atom.swr(worktreeCommandsAtom(worktreeId), {
      staleTime: 0,
      revalidateOnMount: false,
      revalidateOnFocus: true,
      focusSignal: revalidationSignalAtom,
    }),
    () => Duration.millis(COMMAND_CATALOG_POLL_MS),
  ),
);

/**
 * The palette opened on a worktree (or switched worktree while open): start a catalog read now,
 * showing cached data meanwhile, unless one is already in flight (the old observer's
 * `staleTime: 0` mount read, which also joined a running read rather than restarting it).
 */
export function readCommandsOnPaletteOpen(
  registry: AtomRegistry.AtomRegistry,
  worktreeId: number,
): void {
  const catalog = worktreeCommandsAtom(worktreeId);
  if (!registry.get(catalog).waiting) registry.refresh(catalog);
}

/** One command's log metadata (its latest run), refreshed by `keys.commandLog(w, name)`. */
export const commandLogMetadataAtom = Atom.family(
  ([worktreeId, commandName]: readonly [worktreeId: number, commandName: string]) =>
    query(() => fetchCommandLogMetadata(worktreeId, commandName), {
      keys: [keys.commandLog(worktreeId, commandName)],
    }),
);

/**
 * Re-read a command's catalog and its log metadata, in that order, waiting for each re-read that
 * is observed (the old awaited `invalidateQueries` pair). A re-read failure is not the action's.
 */
export const revalidateCommandReadModel = (worktreeId: number, commandName: string) =>
  Effect.andThen(
    revalidate(worktreeCommandsAtom(worktreeId)),
    revalidate(commandLogMetadataAtom([worktreeId, commandName])),
  );

/**
 * Run / stop / restart for one worktree's commands, as fn atoms. Build them per component instance
 * with `useMemo` on the worktree id, so each instance has its own pending/error state (as each
 * `useMutation` had).
 *
 * The request is uninterruptible, so a second click or an unmount never aborts an action that
 * already reached the runtime. The catalog and log metadata are re-read on both outcomes, and the
 * action stays pending until those re-reads land, as the old `onSettled` awaited them.
 */
export const commandActionAtoms = (worktreeId: number | null) => {
  const action = (
    verb: 'run' | 'stop' | 'restart',
    call: (
      worktreeId: number,
      commandName: string,
    ) => Effect.Effect<CommandActionOutput, Error, RuntimeApi>,
  ) =>
    appRuntime.fn((commandName: string) =>
      worktreeId === null
        ? Effect.die(new Error(`Command ${verb} requires an active worktree.`))
        : Effect.uninterruptible(call(worktreeId, commandName)).pipe(
            Effect.ensuring(revalidateCommandReadModel(worktreeId, commandName)),
          ),
    );
  return {
    run: action('run', runCommand),
    stop: action('stop', stopCommand),
    restart: action('restart', restartCommand),
  };
};

/** The pending/error/data state of one command action fn atom. */
export type CommandActionResult = AsyncResult.AsyncResult<CommandActionOutput, Error>;

// --- Active context and surfaces ----------------------------------------------------------------

/**
 * The persisted active context (the last selected project/worktree), used to restore the
 * selection. Its key is independent of the workspace's: a workspace refresh does not re-read it.
 * It is re-read after each accepted persistence (`background-sync.ts`).
 */
export const activeContextAtom = query(() => fetchActiveContext(), {
  keys: [keys.activeContext],
});

/**
 * One surface's detail (layout, panes, sessions): 10 s stale, kept for the app session (the old
 * `gcTime: Infinity`), refreshed by `keys.surface(surfaceId)`. Select `disabledQuery` when there is
 * no surface.
 *
 * A landed read is published on the terminal facts channel (`surface_detail_loaded`), which is how
 * the terminal coordinator re-derives placements (it used to watch the query cache).
 */
export const surfaceDetailAtom = Atom.family((surfaceId: number) =>
  query(
    () =>
      getSurfaceDetail(surfaceId).pipe(
        Effect.tap((detail) =>
          publishTerminalFactEffect({ type: 'surface_detail_loaded', detail }),
        ),
      ),
    { keys: [keys.surface(surfaceId)], idleTTL: Duration.infinity },
  ),
);

// --- Project recheck --------------------------------------------------------------------------------

export type { ProjectRecheckResult } from './commits.js';

/**
 * The same-path recovery action for a missing folder project, one per component instance (build it
 * with `useMemo`). Both stages run inside the fn, so either one failing leaves it a `Failure` with
 * no verdict; `mutationData` is the verdict. Uninterruptible like every write: a restored folder
 * unmounts the component that started the check, and that must not cut the check short (the old
 * mutation was never cancelled either).
 */
export const makeRecheckProjectAtom = () =>
  appRuntime.fn((projectId: number) =>
    Effect.uninterruptible(commits.runProjectRecheck(projectId)),
  );

/** The workspace as displayed, with the old query-result shape. */
export function useWorkspaceResult() {
  const result = useAtomValue(workspaceAtom);
  return {
    data: Option.getOrUndefined(AsyncResult.value(result)),
    isPending: result._tag === 'Initial',
    error: queryError(result),
  };
}

export { formatRuntimeError };
