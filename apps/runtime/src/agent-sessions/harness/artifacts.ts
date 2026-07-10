import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { Effect } from 'effect';

import {
  type ConfigureIsagiSkillArtifacts,
  writeConfigureIsagiSkillArtifacts,
} from './configure-isagi-skill.js';
import { supportedHarnesses, harnessDefinition } from './definitions.js';
import { HarnessAdapterError } from './types.js';

export interface HarnessIntegrationArtifacts {
  readonly configureIsagiSkill: ConfigureIsagiSkillArtifacts;
}

export function prepareHarnessIntegrationArtifacts(dataRoot: string) {
  return Effect.try({
    try: () => {
      const artifactPaths: string[] = [];
      for (const harness of supportedHarnesses) {
        for (const artifact of harnessDefinition(harness).observation.runtimeArtifacts(dataRoot)) {
          writeArtifact(artifact.path, artifact.content);
          artifactPaths.push(artifact.path);
        }
      }
      const configureIsagiSkill = writeConfigureIsagiSkillArtifacts(dataRoot);
      console.info('[runtime] Harness integration artifacts prepared', {
        artifactPaths,
        configureIsagiSkillDirectory: configureIsagiSkill.skillDirectory,
        configureIsagiSkillClaudeWorkspace: configureIsagiSkill.claudeSkillWorkspaceDirectory,
      });
      return { configureIsagiSkill } satisfies HarnessIntegrationArtifacts;
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
