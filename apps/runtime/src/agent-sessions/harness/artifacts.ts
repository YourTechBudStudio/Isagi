import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Effect } from 'effect';

import { supportedHarnesses, harnessDefinition } from './definitions.js';
import { HarnessAdapterError } from './types.js';

export function prepareHarnessIntegrationArtifacts(dataRoot: string) {
  return Effect.try({
    try: () => {
      const retiredSharedSkillRoot = resolve(dataRoot, 'skills', 'shared');
      rmSync(retiredSharedSkillRoot, { recursive: true, force: true });
      const artifactPaths: string[] = [];
      for (const harness of supportedHarnesses) {
        for (const artifact of harnessDefinition(harness).observation.runtimeArtifacts(dataRoot)) {
          writeArtifact(artifact.path, artifact.content);
          artifactPaths.push(artifact.path);
        }
      }
      console.info('[runtime] Harness integration artifacts prepared', {
        artifactPaths,
        retiredSharedSkillRoot,
      });
    },
    catch: (cause) =>
      new HarnessAdapterError(
        'artifact_write_failed',
        'Could not write runtime-owned harness integration artifacts.',
        cause,
      ),
  });
}

function writeArtifact(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
}
