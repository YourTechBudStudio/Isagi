import {
  workflowBuilderVersion,
  workflowSdkVersion,
  workflowVerifierVersion,
} from '@yourtechbudstudio/isagi-workflow-verifier/receipt';

import { readTextAsset, readTextAssetTree } from '../platform/assets/index.js';

// The shipped skill's sources, read from the runtime asset root at module load
// (a missing asset is a build defect). The build copies them from
// `harnesses/skill-content/`, the two config schema sources, and the verifier's
// canonical workflow fixture (`scripts/sync-runtime-assets.mjs`).

export const configSchemaReferenceSources = {
  'runtime-config.schema.ts': readTextAsset('config-schemas/runtime-config.schema.ts'),
  'project-config.schema.ts': readTextAsset('config-schemas/project-config.schema.ts'),
} as const;

export const isagiDocsContentSources = {
  'SKILL.md': readTextAsset('isagi-docs/SKILL.md'),
  'config-global.md': readTextAsset('isagi-docs/config-global.md'),
  'config-project.md': readTextAsset('isagi-docs/config-project.md'),
  'workflows.md': readTextAsset('isagi-docs/workflows.md'),
  'workflow-environments.md': readTextAsset('isagi-docs/workflow-environments.md'),
  'workflow-agents.md': readTextAsset('isagi-docs/workflow-agents.md'),
  'workflow-recovery.md': readTextAsset('isagi-docs/workflow-recovery.md'),
  'workflow-checkpoints.md': readTextAsset('isagi-docs/workflow-checkpoints.md'),
  'cli-investigate-runs.md': readTextAsset('isagi-docs/cli-investigate-runs.md'),
  'cli-reconstruct-and-launch.md': readTextAsset('isagi-docs/cli-reconstruct-and-launch.md'),
} as const;

/**
 * The canonical workflow scaffold, copied verbatim from the verifier fixture at build time and
 * keyed by POSIX-relative path (e.g. `src/index.ts`). The shipped skill emits these as reference
 * files, and an anti-drift test asserts the emitted bytes equal these source bytes.
 */
export const workflowScaffoldSources: ReadonlyMap<string, string> = readWorkflowScaffoldSources();

function readWorkflowScaffoldSources(): ReadonlyMap<string, string> {
  const { directory, files } = readTextAssetTree('minimal-workflow');
  if (files.size === 0) {
    throw new Error(`No workflow scaffold assets found under ${directory}.`);
  }
  return files;
}

/** The skill's directory name and its `name:` frontmatter field. Must match `skill-content/SKILL.md`. */
export const isagiDocsName = 'isagi-docs';

/**
 * The generated skill package. Reconciliation writes a complete copy into each selected harness's
 * native global skill directory; no installed copy depends on a shared runtime-owned folder.
 */
export function isagiDocsPackageFiles(dataRoot: string): ReadonlyMap<string, string> {
  const substitutions = new Map([
    ['DATA_ROOT', dataRoot],
    ['SDK_VERSION', workflowSdkVersion],
    ['VERIFIER_VERSION', workflowVerifierVersion],
    ['BUILDER_VERSION', workflowBuilderVersion],
  ]);

  const files = new Map<string, string>();
  files.set('SKILL.md', render('SKILL.md', substitutions));
  files.set('references/config-global.md', render('config-global.md', substitutions));
  files.set('references/config-project.md', render('config-project.md', substitutions));
  files.set('references/workflows.md', render('workflows.md', substitutions));
  files.set(
    'references/workflow-environments.md',
    render('workflow-environments.md', substitutions),
  );
  files.set('references/workflow-agents.md', render('workflow-agents.md', substitutions));
  files.set('references/workflow-recovery.md', render('workflow-recovery.md', substitutions));
  files.set('references/workflow-checkpoints.md', render('workflow-checkpoints.md', substitutions));
  files.set('references/cli-investigate-runs.md', render('cli-investigate-runs.md', substitutions));
  files.set(
    'references/cli-reconstruct-and-launch.md',
    render('cli-reconstruct-and-launch.md', substitutions),
  );
  files.set(
    'references/config-global.schema.ts',
    configSchemaReferenceSources['runtime-config.schema.ts'],
  );
  files.set(
    'references/config-project.schema.ts',
    configSchemaReferenceSources['project-config.schema.ts'],
  );

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
