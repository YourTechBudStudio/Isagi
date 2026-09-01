import { mkdirSync } from 'node:fs';
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

export const DataDirectoryLive = Layer.effect(
  DataDirectory,
  Effect.try({
    try: () => {
      const root = normalizeHomePath(
        process.env.ISAGI_DATA_DIR ?? process.env.ISAGI_HOME ?? '~/.isagi',
      );
      const paths = {
        root,
        databasePath: resolve(root, 'isagi.db'),
        statePath: resolve(root, 'state.json'),
        worktreesPath: resolve(root, 'worktrees'),
        sessionsPath: resolve(root, 'sessions'),
        workflowsPath: resolve(root, 'workflows'),
        toolsPath: resolve(root, 'tools'),
        editorsPath: resolve(root, 'editors'),
      } satisfies IsagiDataDirectory;

      mkdirSync(paths.root, { recursive: true });
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
