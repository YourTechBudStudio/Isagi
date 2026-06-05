import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { Context, Data, Effect, Layer } from 'effect';

import { normalizeHomePath } from '../paths/path-utils.js';

export class DataDirectoryError extends Data.TaggedError('DataDirectoryError')<{
  readonly cause: unknown;
}> {}

export interface IsagiDataDirectory {
  readonly root: string;
  readonly databasePath: string;
  readonly statePath: string;
  readonly worktreesPath: string;
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
      } satisfies IsagiDataDirectory;

      mkdirSync(paths.root, { recursive: true });
      mkdirSync(paths.worktreesPath, { recursive: true });

      return { paths } satisfies DataDirectoryService;
    },
    catch: (cause) => new DataDirectoryError({ cause }),
  }),
);
