import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { Context, Data, Effect, Layer } from 'effect';

import { normalizeHomePath } from '../paths/path.utils.js';

export class DataDirectoryError extends Data.TaggedError('DataDirectoryError')<{
  readonly cause: unknown;
}> {}

export interface IsagiDataDirectory {
  readonly root: string;
  readonly databasePath: string;
  readonly statePath: string;
  readonly worktreesPath: string;
  readonly sessionsPath: string;
  readonly workflowsPath: string;
  /**
   * Versioned Isagi-owned tool installations: `<root>/tools/<tool>/<version>/`.
   * Isagi owns this root; the *contents* are provider-specific and are created
   * by whichever capability-gated service provisions them.
   */
  readonly toolsPath: string;
  /**
   * Editor state shared across every worktree: user data, configuration,
   * extensions, and per-incarnation session sockets. Same ownership split as
   * `toolsPath` — the root is generic, its contents are not.
   */
  readonly editorsPath: string;
}

export interface DataDirectoryService {
  readonly paths: IsagiDataDirectory;
}

export const DataDirectory = Context.GenericTag<DataDirectoryService>('isagi/DataDirectory');

/**
 * The Isagi-owned paths under one data root, with the root canonicalized.
 *
 * The canonicalization is not cosmetic. Isagi derives a worktree's checkout path from
 * `worktreesPath` and hands that string to `git worktree add`; Git then reports the checkout back
 * through `git worktree list` **fully resolved**, and that resolved spelling is what reconciliation
 * stores in `worktrees.path`. Any symlink in the data root — a home directory on a linked volume,
 * a `/var`-style temporary root, a hand-symlinked `ISAGI_DATA_DIR` — therefore leaves Isagi holding
 * one spelling of a directory and the database holding another.
 *
 * That difference is cosmetic right up until something compares the two, and workflow environment
 * preparation does: adopting the checkout an interrupted attempt left behind turns on
 * `candidate.path === preparation.checkout_path`. Under two spellings that comparison can never be
 * true, so the adoption never happens, and the run is stranded behind a checkout Git refuses to
 * create again — reported as a collision with a worktree "this run did not create". Resolving once,
 * here, is what makes every consumer agree by construction rather than by coincidence.
 *
 * Same shape as `normalizeProjectPath` in `git/project-root.ts`, and for the same reason: a path
 * that has to agree with Git is realpath-ed, falling back to the resolved spelling when the
 * directory does not exist yet. `DataDirectoryLive` closes that gap by creating the root *before*
 * deriving from it, so the fallback is never taken on the path that matters.
 */
export function isagiDataDirectoryPaths(root: string): IsagiDataDirectory {
  const canonical = canonicalPath(normalizeHomePath(root));
  return {
    root: canonical,
    databasePath: resolve(canonical, 'isagi.db'),
    statePath: resolve(canonical, 'state.json'),
    worktreesPath: resolve(canonical, 'worktrees'),
    sessionsPath: resolve(canonical, 'sessions'),
    workflowsPath: resolve(canonical, 'workflows'),
    toolsPath: resolve(canonical, 'tools'),
    editorsPath: resolve(canonical, 'editors'),
  } satisfies IsagiDataDirectory;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export const DataDirectoryLive = Layer.effect(
  DataDirectory,
  Effect.try({
    try: () => {
      const requested = normalizeHomePath(
        process.env.ISAGI_DATA_DIR ?? process.env.ISAGI_HOME ?? '~/.isagi',
      );
      // Created before the paths are derived, and the order is load-bearing: `realpathSync` can
      // only resolve a directory that exists, so deriving first would silently keep the unresolved
      // spelling on exactly the run that matters most — a fresh install under a symlinked home.
      mkdirSync(requested, { recursive: true });
      const paths = isagiDataDirectoryPaths(requested);

      mkdirSync(paths.worktreesPath, { recursive: true });
      mkdirSync(paths.sessionsPath, { recursive: true });
      mkdirSync(paths.workflowsPath, { recursive: true });
      // Created eagerly beside the other Isagi-owned roots even on a runtime
      // that will never provision anything into them: an empty directory costs
      // nothing, and creating them here keeps "who owns this location" a single
      // answer rather than one that depends on whether a capability was declared.
      mkdirSync(paths.toolsPath, { recursive: true });
      mkdirSync(paths.editorsPath, { recursive: true });

      return { paths } satisfies DataDirectoryService;
    },
    catch: (cause) => new DataDirectoryError({ cause }),
  }),
);
