import {
  workflowBuilderVersion,
  workflowSdkVersion,
  workflowVerifierVersion,
} from '@yourtechbudstudio/isagi-workflow-verifier/receipt';

import {
  configSchemaReferenceSources,
  isagiDocsContentSources,
  workflowScaffoldSources,
} from '../../runtime-assets.js';

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
