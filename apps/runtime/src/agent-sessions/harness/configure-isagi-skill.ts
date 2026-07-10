import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  configSchemaReferenceSources,
  configureIsagiSkillContentSources,
  runtimePackageVersion,
  workflowSdkReferenceSources,
} from '../../runtime-assets.js';

/** The skill's directory name and its `name:` frontmatter field. Must match `skill-content/SKILL.md`. */
export const configureIsagiSkillName = 'configure-isagi';

export interface ConfigureIsagiSkillArtifacts {
  readonly skillDirectory: string;
  readonly skillScanDirectory: string;
  readonly claudeSkillWorkspaceDirectory: string;
}

export function configureIsagiSkillArtifactPaths(dataRoot: string): ConfigureIsagiSkillArtifacts {
  return {
    skillDirectory: resolve(dataRoot, 'skills', 'shared', configureIsagiSkillName),
    skillScanDirectory: resolve(dataRoot, 'skills', 'shared'),
    claudeSkillWorkspaceDirectory: resolve(
      dataRoot,
      'harness-integrations',
      'claude',
      'skill-workspace',
    ),
  };
}

/**
 * Both scan roots are wiped, not just the directories we are about to write. OpenCode scans
 * `skillScanDirectory` recursively for any `SKILL.md`, so a skill directory left behind by an older
 * build - after a rename, say - would be discovered alongside the current one under a stale name.
 * These two trees are runtime-owned in their entirety; nothing else may write into them.
 */
export function writeConfigureIsagiSkillArtifacts(dataRoot: string) {
  const artifacts = configureIsagiSkillArtifactPaths(dataRoot);
  const packageFiles = configureIsagiSkillPackageFiles(dataRoot);
  const claudeSkillDirectory = resolve(
    artifacts.claudeSkillWorkspaceDirectory,
    '.claude',
    'skills',
    configureIsagiSkillName,
  );

  rmSync(artifacts.skillScanDirectory, { recursive: true, force: true });
  rmSync(artifacts.claudeSkillWorkspaceDirectory, { recursive: true, force: true });
  writeSkillDirectory(artifacts.skillDirectory, packageFiles);
  writeSkillDirectory(claudeSkillDirectory, packageFiles);

  return artifacts;
}

/**
 * The generated skill package. Handwritten prose lives in `skill-content/*.md` and reaches this map
 * through the build-time source manifest; the placeholders below are the only points where generated
 * values meet that prose.
 */
export function configureIsagiSkillPackageFiles(dataRoot: string): ReadonlyMap<string, string> {
  const substitutions = new Map([
    ['VERSION', runtimePackageVersion],
    ['DATA_ROOT', dataRoot],
    [
      'RUNTIME_CONFIG_SCHEMA',
      trimTrailingNewline(configSchemaReferenceSources['runtime-config.schema.ts']),
    ],
    [
      'PROJECT_CONFIG_SCHEMA',
      trimTrailingNewline(configSchemaReferenceSources['project-config.schema.ts']),
    ],
  ]);

  const files = new Map<string, string>();
  files.set('SKILL.md', render('SKILL.md', substitutions));
  files.set('references/config-global.md', render('config-global.md', substitutions));
  files.set('references/config-project.md', render('config-project.md', substitutions));
  files.set('references/workflows.md', render('workflows.md', substitutions));

  for (const [path, source] of Object.entries(workflowSdkReferenceSources)) {
    files.set(`references/sdk/${flattenReferencePath(path)}`, source);
  }

  return files;
}

function render(
  name: keyof typeof configureIsagiSkillContentSources,
  substitutions: ReadonlyMap<string, string>,
) {
  const rendered = configureIsagiSkillContentSources[name].replaceAll(
    /\{\{(\w+)\}\}/g,
    (match, token: string) => substitutions.get(token) ?? match,
  );
  const survivor = /\{\{\w+\}\}/.exec(rendered);
  if (survivor) {
    throw new Error(`Unsubstituted placeholder ${survivor[0]} in skill content ${name}.`);
  }
  return rendered;
}

function trimTrailingNewline(source: string) {
  return source.replace(/\n+$/, '');
}

function writeSkillDirectory(skillDirectory: string, files: ReadonlyMap<string, string>) {
  for (const [relativePath, source] of files) {
    writeFile(resolve(skillDirectory, relativePath), source);
  }
}

function writeFile(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
}

function flattenReferencePath(path: string) {
  return path.split(/[\\/]+/).join('__');
}
