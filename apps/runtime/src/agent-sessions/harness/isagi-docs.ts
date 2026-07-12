import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  workflowSdkVersion,
  workflowVerifierVersion,
} from '@yourtechbudstudio/isagi-workflow-verifier/receipt';

import {
  configSchemaReferenceSources,
  isagiDocsContentSources,
  runtimePackageVersion,
  workflowScaffoldSources,
} from '../../runtime-assets.js';

/** The skill's directory name and its `name:` frontmatter field. Must match `skill-content/SKILL.md`. */
export const isagiDocsName = 'isagi-docs';

export interface IsagiDocsArtifacts {
  readonly skillDirectory: string;
}

export function isagiDocsArtifactPaths(dataRoot: string): IsagiDocsArtifacts {
  return {
    skillDirectory: resolve(dataRoot, 'skills', 'shared', isagiDocsName),
  };
}

/**
 * The shared skill root is runtime-owned. Rebuilding it removes stale content from older versions
 * before publishing the canonical package used by native renderers and the OpenCode command.
 */
export function writeIsagiDocsArtifacts(dataRoot: string) {
  const artifacts = isagiDocsArtifactPaths(dataRoot);
  const packageFiles = isagiDocsPackageFiles(dataRoot);
  rmSync(resolve(dataRoot, 'skills', 'shared'), { recursive: true, force: true });
  writeSkillDirectory(artifacts.skillDirectory, packageFiles);

  return artifacts;
}

/**
 * The generated skill package. Handwritten prose lives in `skill-content/*.md` and reaches this map
 * through the build-time source manifest; the placeholders below are the only points where generated
 * values meet that prose.
 */
export function isagiDocsPackageFiles(dataRoot: string): ReadonlyMap<string, string> {
  const substitutions = new Map([
    ['VERSION', runtimePackageVersion],
    ['DATA_ROOT', dataRoot],
    ['SDK_VERSION', workflowSdkVersion],
    ['VERIFIER_VERSION', workflowVerifierVersion],
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

  for (const [relativePath, source] of workflowScaffoldSources) {
    // Emitted verbatim (never through render) so the shipped scaffold is byte-identical to the
    // verifier fixture and untouched by placeholder substitution.
    files.set(`references/minimal-workflow/${relativePath}`, source);
  }

  return files;
}

function render(
  name: keyof typeof isagiDocsContentSources,
  substitutions: ReadonlyMap<string, string>,
) {
  const rendered = isagiDocsContentSources[name].replaceAll(
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
