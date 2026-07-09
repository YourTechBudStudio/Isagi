import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Effect } from 'effect';

import { claudeHookSource, claudeSettings } from './claude/artifacts.js';
import { codexHookSource } from './codex/artifacts.js';
import {
  configureIsagiSkillArtifactPaths,
  type ConfigureIsagiSkillArtifacts,
  writeConfigureIsagiSkillArtifacts,
} from './configure-isagi-skill.js';
import { opencodePluginSource } from './opencode/artifacts.js';
import { piExtensionSource } from './pi/artifacts.js';
import { HarnessAdapterError } from './types.js';

export interface HarnessIntegrationArtifacts {
  readonly piExtensionPath: string;
  readonly opencodePluginPath: string;
  readonly claudeSettingsPath: string;
  readonly claudeHookPath: string;
  readonly codexHookPath: string;
  readonly configureIsagiSkill: ConfigureIsagiSkillArtifacts;
}

export function prepareHarnessIntegrationArtifacts(dataRoot: string) {
  return Effect.try({
    try: () => {
      const artifacts = artifactPaths(dataRoot);
      writeArtifact(artifacts.piExtensionPath, piExtensionSource());
      writeArtifact(artifacts.opencodePluginPath, opencodePluginSource());
      writeArtifact(artifacts.claudeHookPath, claudeHookSource());
      writeArtifact(
        artifacts.claudeSettingsPath,
        `${JSON.stringify(
          claudeSettings({
            hookPath: artifacts.claudeHookPath,
          }),
          null,
          2,
        )}\n`,
      );
      writeConfigureIsagiSkillArtifacts(dataRoot);
      writeArtifact(artifacts.codexHookPath, codexHookSource());
      console.info('[runtime] Harness integration artifacts prepared', {
        piExtensionPath: artifacts.piExtensionPath,
        opencodePluginPath: artifacts.opencodePluginPath,
        claudeSettingsPath: artifacts.claudeSettingsPath,
        codexHookPath: artifacts.codexHookPath,
        configureIsagiSkillDirectory: artifacts.configureIsagiSkill.skillDirectory,
        configureIsagiSkillClaudeWorkspace:
          artifacts.configureIsagiSkill.claudeSkillWorkspaceDirectory,
      });
      return artifacts;
    },
    catch: (cause) =>
      new HarnessAdapterError(
        'artifact_write_failed',
        'Could not write runtime-owned harness integration artifacts.',
        cause,
      ),
  });
}

function artifactPaths(dataRoot: string): HarnessIntegrationArtifacts {
  const root = resolve(dataRoot, 'harness-integrations');
  return {
    piExtensionPath: resolve(root, 'pi', 'isagi-session.ts'),
    opencodePluginPath: resolve(root, 'opencode', 'isagi-session-plugin.js'),
    claudeSettingsPath: resolve(root, 'claude', 'settings.json'),
    claudeHookPath: resolve(root, 'claude', 'isagi-claude-hook.mjs'),
    codexHookPath: resolve(root, 'codex', 'isagi-codex-hook.mjs'),
    configureIsagiSkill: configureIsagiSkillArtifactPaths(dataRoot),
  };
}

function writeArtifact(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
}
