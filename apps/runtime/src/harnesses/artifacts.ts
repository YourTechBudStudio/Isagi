import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Effect } from 'effect';

import { supportedHarnesses, harnessDefinition } from './definitions.js';
import { HarnessAdapterError } from './types.js';

export const prepareHarnessIntegrationArtifacts = Effect.fn(
  'harnesses.prepareHarnessIntegrationArtifacts',
)(function* (dataRoot: string) {
  const retiredSharedSkillRoot = resolve(dataRoot, 'skills', 'shared');
  const artifactPaths = yield* Effect.try({
    try: () => {
      rmSync(retiredSharedSkillRoot, { recursive: true, force: true });
      const written: string[] = [];
      for (const harness of supportedHarnesses) {
        for (const artifact of harnessDefinition(harness).observation.runtimeArtifacts(dataRoot)) {
          writeArtifact(artifact.path, artifact.content);
          written.push(artifact.path);
        }
      }
      return written;
    },
    catch: (cause) =>
      new HarnessAdapterError(
        'artifact_write_failed',
        'Could not write runtime-owned harness integration artifacts.',
        cause,
      ),
  });
  yield* Effect.logInfo('Harness integration artifacts prepared').pipe(
    Effect.annotateLogs({ artifactPaths, retiredSharedSkillRoot }),
  );
});

function writeArtifact(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
}
