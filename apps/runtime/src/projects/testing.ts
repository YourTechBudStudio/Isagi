import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Layer } from 'effect';

import { DataDirectory, RuntimeDatabase } from '../platform/persistence/index.js';
import { makeTestDataDirectory } from '../platform/persistence/testing.js';
import { ProjectRepository } from './repository.js';

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
  const database = RuntimeDatabase.layer.pipe(Layer.provide(dataDirectoryLayer));
  const repository = ProjectRepository.layer.pipe(Layer.provide(database));
  return Layer.mergeAll(database, repository);
}

/** Runs `build` against a throwaway database rooted in its own temp directory. */
export function runWithDatabase<A, E>(
  name: string,
  build: Effect.Effect<A, E, RuntimeDatabase | ProjectRepository>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), `isagi-${name}-`));
  return Effect.runPromise(build.pipe(Effect.provide(repositoryTestLayer(dataRoot)))).finally(
    () => {
      rmSync(dataRoot, { recursive: true, force: true });
    },
  );
}

// Internals and builders other modules' tests use; never imported by production code.
export { defaultCommandLifecycle, projectConfigSchema } from './config/config-schema.js';
export { prunedWorktreeIds } from './repository.js';
