import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Layer } from 'effect';

import {
  DataDirectory,
  RuntimeDatabaseLive,
  type RuntimeDatabaseService,
} from '../../persistence/index.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import {
  WorkspaceRepositoryLive,
  type WorkspaceRepositoryService,
} from '../workspace.repository.js';

/**
 * The narrowest graph that can exercise the workspace repository: a real
 * database over a throwaway data directory, and nothing else. Deliberately
 * distinct from the surfaces test layer, which composes surfaces and editor
 * contexts as well and is what `durability.test.ts` needs instead.
 *
 * Private on purpose — `runWithDatabase` is the only intended consumer, so the
 * layer itself is not part of this module's surface.
 */
function repositoryTestLayer(dataRoot: string) {
  const dataDirectoryLayer = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const repository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  return Layer.mergeAll(database, repository);
}

/** Runs `build` against a throwaway database rooted in its own temp directory. */
export function runWithDatabase<A, E>(
  name: string,
  build: Effect.Effect<A, E, RuntimeDatabaseService | WorkspaceRepositoryService>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), `isagi-${name}-`));
  return Effect.runPromise(build.pipe(Effect.provide(repositoryTestLayer(dataRoot)))).finally(
    () => {
      rmSync(dataRoot, { recursive: true, force: true });
    },
  );
}
