import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  workflowBuilderVersion,
  workflowSdkVersion,
  workflowVerifierVersion,
} from '@yourtechbudstudio/isagi-workflow-verifier/receipt';

import { projectConfigSchema } from '../../project-config/project-config.schema.js';
import {
  configSchemaReferenceSources,
  isagiDocsContentSources,
  runtimePackageVersion,
  workflowScaffoldSources,
} from '../../runtime-assets.js';
import { runtimeConfigSchema } from '../../runtime-config/runtime-config.schema.js';
import {
  isagiDocsArtifactPaths,
  isagiDocsName,
  isagiDocsPackageFiles,
  writeIsagiDocsArtifacts,
} from './isagi-docs.js';

const dataRoot = '/Users/example/.isagi';
const files = isagiDocsPackageFiles(dataRoot);
const handwritten = [...files];

/** Mirrors the generator's own trimming so a value assertion compares like with like. */
const trimTrailingNewline = (source: string) => source.replace(/\n+$/, '');

/** Every placeholder the generator substitutes, and the text it must expand to. */
const substitutions = {
  VERSION: runtimePackageVersion,
  DATA_ROOT: dataRoot,
  SDK_VERSION: workflowSdkVersion,
  VERIFIER_VERSION: workflowVerifierVersion,
  BUILDER_VERSION: workflowBuilderVersion,
  RUNTIME_CONFIG_SCHEMA: trimTrailingNewline(
    configSchemaReferenceSources['runtime-config.schema.ts'],
  ),
  PROJECT_CONFIG_SCHEMA: trimTrailingNewline(
    configSchemaReferenceSources['project-config.schema.ts'],
  ),
} as const;

/** Which template carries which placeholder, and where it is emitted. */
const templates = {
  'SKILL.md': { emittedAs: 'SKILL.md', tokens: ['VERSION', 'DATA_ROOT'] },
  'config-global.md': {
    emittedAs: 'references/config-global.md',
    tokens: ['DATA_ROOT', 'RUNTIME_CONFIG_SCHEMA'],
  },
  'config-project.md': {
    emittedAs: 'references/config-project.md',
    tokens: ['PROJECT_CONFIG_SCHEMA'],
  },
  'workflows.md': {
    emittedAs: 'references/workflows.md',
    tokens: ['SDK_VERSION', 'VERIFIER_VERSION', 'BUILDER_VERSION'],
  },
} as const satisfies Record<
  keyof typeof isagiDocsContentSources,
  { readonly emittedAs: string; readonly tokens: readonly (keyof typeof substitutions)[] }
>;

test('no placeholder survives into an emitted skill file', () => {
  for (const [path, source] of files) {
    assert.equal(
      /\{\{\w+\}\}/.test(source),
      false,
      `${path} shipped with an unsubstituted placeholder`,
    );
  }
});

/**
 * The check above only catches a placeholder that was never substituted. A placeholder that is
 * *destroyed* - by a formatter parsing the fenced ts block it sits in and rewriting it, which is
 * exactly what happened once - leaves no `{{` behind, so the negative check passes while the
 * generated content silently vanishes. These two tests are the ones that actually hold the line:
 * pin the placeholders each template must carry, then assert every substituted value lands in the
 * file that frames it.
 */
test('each content template carries the placeholders it is meant to carry', () => {
  for (const [name, { tokens }] of Object.entries(templates)) {
    const template = isagiDocsContentSources[name as keyof typeof templates];
    for (const token of tokens) {
      assert.equal(
        template.includes(`{{${token}}}`),
        true,
        `${name} lost its {{${token}}} placeholder`,
      );
    }
  }
});

test('every substituted value reaches the emitted file that frames it', () => {
  const asserted = new Set<string>();

  for (const [name, { emittedAs, tokens }] of Object.entries(templates)) {
    const emitted = files.get(emittedAs);
    assert.ok(emitted, `${name} was not emitted as ${emittedAs}`);
    for (const token of tokens) {
      assert.equal(
        emitted.includes(substitutions[token]),
        true,
        `${emittedAs} is missing the text substituted for {{${token}}}`,
      );
      asserted.add(token);
    }
  }

  // A placeholder that no template references any more is dead substitution machinery.
  assert.deepEqual([...asserted].sort(), Object.keys(substitutions).sort());
});

test('the skill package holds exactly the indexed references', () => {
  assert.deepEqual(
    handwritten.map(([path]) => path),
    [
      'SKILL.md',
      'references/config-global.md',
      'references/config-project.md',
      'references/workflows.md',
      'references/minimal-workflow/package.json',
      'references/minimal-workflow/src/index.ts',
      'references/minimal-workflow/tests/workflow.test.ts',
      'references/minimal-workflow/tsconfig.json',
    ],
  );
  assert.equal(
    [...files].some(([path]) => path.startsWith('references/sdk/')),
    false,
  );
});

test('the skill name matches its frontmatter and its directory', () => {
  const router = files.get('SKILL.md') ?? '';
  assert.match(router, new RegExp(`^name: ${isagiDocsName}$`, 'm'));

  const artifacts = isagiDocsArtifactPaths(dataRoot);
  assert.equal(basename(artifacts.skillDirectory), isagiDocsName);
  assert.equal(dirname(artifacts.skillDirectory), resolve(dataRoot, 'skills', 'shared'));
});

test('the router reads as a versioned skill package', () => {
  const router = files.get('SKILL.md') ?? '';
  assert.match(router, new RegExp(`^  version: "${runtimePackageVersion}"$`, 'm'));
  assert.equal(router.includes(`${dataRoot}/config.yaml`), true);
  assert.equal(router.includes(`${dataRoot}/workflows/<key>/`), true);
  assert.match(router, /Read only the reference that matches the request/);
});

test('the workflow reference uses the scaffold and installed SDK as authoring sources', () => {
  const workflows = files.get('references/workflows.md') ?? '';
  assert.match(workflows, /Read every file in the bundled/);
  assert.match(
    workflows,
    /node_modules\/@yourtechbudstudio\/isagi-workflow-sdk\/dist\/index\.d\.ts/,
  );
  assert.match(workflows, /After all authoring changes are complete/);
  assert.doesNotMatch(workflows, /After every edit/);
  assert.doesNotMatch(workflows, /build receipt|artifact hash|pinned artifact/i);
});

test('the workflow reference preserves non-type-level authoring conventions', () => {
  const workflows = files.get('references/workflows.md') ?? '';
  for (const convention of [
    /state\.stage\.kind/,
    /JSON-serializable/,
    /wait\.workflow/,
    /operational calls as replayable/,
    /latest complete assistant turn/,
    /one reusable judgment contract.*each orchestrated agent session/,
    /every tagged judgment outcome.*non-linear jumps/,
    /setUiFeedback/,
    /one Node ESM artifact/,
    /tests hermetic/,
  ]) {
    assert.match(workflows, convention);
  }
});

test('the workflow reference documents prompt modifiers', () => {
  const workflows = files.get('references/workflows.md') ?? '';
  // Section presence and the durable authoring rules, asserted as facts rather than pinned prose.
  assert.match(workflows, /^## Prompt input and modifiers$/m);
  assert.match(workflows, /skills stack/i);
  assert.match(workflows, /command must be the only modifier/i);
  assert.match(workflows, /does not check that a skill or command exists/i);
  assert.match(workflows, /Headless OpenCode/);
  assert.match(workflows, /UI-only commands/i);
  // Per-harness rendering tokens: Pi's skill form, the shared slash-command form, and Codex's sigil.
  for (const token of ['/skill:<name>', '/<name>', '$<name>']) {
    assert.ok(workflows.includes(token), `workflow reference lost the ${token} rendering token`);
  }
  for (const harness of ['pi', 'opencode', 'claude', 'codex']) {
    assert.match(
      workflows,
      new RegExp('`' + harness + '`'),
      `workflow reference never names the ${harness} harness`,
    );
  }
});

/**
 * Field-level drift cannot happen: the schema source is embedded verbatim and the router declares it
 * authoritative over the prose. A new *top-level* section is the gap. The router would keep silently
 * omitting it, and the "does not configure today" ground rule would keep denying a feature that now
 * exists. This test covers exactly that slice and no more - it cannot see a whole new config file, a
 * new discovery root, or a new feature area, which is why the root AGENTS.md rule exists too.
 */
test('the router names every top-level config key the schemas define', () => {
  const router = files.get('SKILL.md') ?? '';
  const topLevelKeys = [
    ...Object.keys(runtimeConfigSchema.fields),
    ...Object.keys(projectConfigSchema.fields),
  ];
  assert.ok(topLevelKeys.length > 0, 'read no top-level keys off the config schemas');

  for (const key of topLevelKeys) {
    // Named inside a code span, so prose that merely uses the English word does not count.
    assert.match(
      router,
      new RegExp(`\`[^\`\n]*\\b${key}\\b[^\`\n]*\``),
      `SKILL.md never names the top-level config key \`${key}\``,
    );
  }
});

test('skill references do not carry generated contents sections', () => {
  for (const [path, source] of handwritten) {
    if (path === 'SKILL.md') continue;
    assert.doesNotMatch(source, /^## Contents$/m, `${path} includes a contents section`);
  }
});

test('skill prose is portable and self-contained', () => {
  for (const [path, source] of handwritten) {
    // Prose portability applies to the Markdown references; the scaffold ships real code files.
    if (!path.endsWith('.md')) continue;
    // The reader has neither the Isagi repository nor its docs. Nothing may point at them.
    assert.doesNotMatch(source, /docs\//, `${path} references a repository doc path`);
    assert.doesNotMatch(source, /workflow-engine\.md/, `${path} references a repository doc`);
    assert.doesNotMatch(source, /apps\/runtime/, `${path} references a repository source path`);
    assert.doesNotMatch(
      source,
      /implement-phase-wise-plan/,
      `${path} references the sample workflow`,
    );

    // The same bytes serve Claude, Pi, and OpenCode. No harness-specific syntax.
    assert.doesNotMatch(source, /\$\{CLAUDE_SKILL_DIR\}/, `${path} uses Claude-only syntax`);
    assert.doesNotMatch(source, /!`/, `${path} uses Claude-only command substitution`);
  }

  const router = files.get('SKILL.md') ?? '';
  assert.doesNotMatch(router, /^compatibility:/m);
  assert.doesNotMatch(router, /^allowed-tools:/m);
});

/**
 * OpenCode scans the shared parent recursively for any `SKILL.md`. A skill directory left behind by
 * an older build - the pre-rename `isagi-configure`, for one - would be discovered next to the
 * current one under a stale name, which is precisely the duplicate-skill state the layout exists to
 * prevent. Regeneration must wipe the scan root, not just its own subdirectory.
 */
test('regeneration removes a skill directory left behind under an older name', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-skill-rename-'));
  try {
    const artifacts = isagiDocsArtifactPaths(root);
    const staleSkill = resolve(root, 'skills', 'shared', 'isagi-configure');
    mkdirSync(staleSkill, { recursive: true });
    writeFileSync(resolve(staleSkill, 'SKILL.md'), '---\nname: isagi-configure\n---\n', 'utf8');

    writeIsagiDocsArtifacts(root);

    assert.equal(existsSync(staleSkill), false, 'stale skill survived under the shared scan root');
    assert.equal(existsSync(resolve(artifacts.skillDirectory, 'SKILL.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The scaffold is shipped as reference files copied verbatim from the verifier fixture. Emitting it
 * raw (never through placeholder substitution) is what keeps the installed bytes identical to the
 * canonical fixture an author copies. This holds that line, and the exact-set assertion catches a
 * scaffold file added or removed without the sync/generator following.
 */
test('the emitted scaffold files are byte-identical to the source assets', () => {
  assert.ok(workflowScaffoldSources.size > 0, 'expected scaffold source assets');
  for (const [relativePath, source] of workflowScaffoldSources) {
    assert.equal(
      files.get(`references/minimal-workflow/${relativePath}`),
      source,
      `references/minimal-workflow/${relativePath} drifted from its source asset`,
    );
  }
  const emitted = [...files.keys()]
    .filter((path) => path.startsWith('references/minimal-workflow/'))
    .map((path) => path.slice('references/minimal-workflow/'.length))
    .sort();
  assert.deepEqual(emitted, [...workflowScaffoldSources.keys()].sort());
});

test('the rendered workflow reference and shipped scaffold name the recommended pair', () => {
  const workflows = files.get('references/workflows.md') ?? '';
  assert.ok(
    workflows.includes(`@yourtechbudstudio/isagi-workflow-sdk@${workflowSdkVersion}`),
    'workflow reference states the SDK pin',
  );
  assert.ok(
    workflows.includes(`@yourtechbudstudio/isagi-workflow-verifier@${workflowVerifierVersion}`),
    'workflow reference states the verifier pin',
  );
  assert.ok(
    workflows.includes(`esbuild@${workflowBuilderVersion}`),
    'workflow reference states the builder pin',
  );

  const scaffold = files.get('references/minimal-workflow/package.json') ?? '';
  assert.ok(
    scaffold.includes(`"@yourtechbudstudio/isagi-workflow-sdk": "${workflowSdkVersion}"`),
    'scaffold pins the SDK exactly',
  );
  assert.ok(
    scaffold.includes(`"@yourtechbudstudio/isagi-workflow-verifier": "${workflowVerifierVersion}"`),
    'scaffold pins the verifier exactly',
  );
  assert.ok(
    scaffold.includes(`"esbuild": "${workflowBuilderVersion}"`),
    'scaffold pins the builder exactly',
  );
});

test('the canonical skill is manual-only', () => {
  const router = files.get('SKILL.md') ?? '';
  assert.match(router, /^disable-model-invocation: true$/m);
});
