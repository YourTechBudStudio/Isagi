import assert from 'node:assert/strict';
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
  workflowScaffoldSources,
} from '../../runtime-assets.js';
import { runtimeConfigSchema } from '../../runtime-config/runtime-config.schema.js';
import { isagiDocsName, isagiDocsPackageFiles } from './isagi-docs.js';

const dataRoot = '/Users/example/.isagi';
const files = isagiDocsPackageFiles(dataRoot);
const handwritten = [...files];

/** Mirrors the generator's own trimming so a value assertion compares like with like. */
const trimTrailingNewline = (source: string) => source.replace(/\n+$/, '');

/** Every placeholder the generator substitutes, and the text it must expand to. */
const substitutions = {
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
  'SKILL.md': { emittedAs: 'SKILL.md', tokens: ['DATA_ROOT'] },
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

test('the skill name matches its frontmatter', () => {
  const router = files.get('SKILL.md') ?? '';
  assert.match(router, new RegExp(`^name: ${isagiDocsName}$`, 'm'));
});

test('the router reads as a focused skill package', () => {
  const router = files.get('SKILL.md') ?? '';
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

/**
 * The top-level-key test above passes for `workflows` only incidentally - the word appears inside the
 * default `.../workflows/<key>/` path span. This guard is the one that actually holds the routing row:
 * additional-directory requests must reach the global config reference, or the configurable surface
 * silently regresses into the "Isagi does not configure it today" boundary.
 */
test('the router routes additional workflow directories to the global config reference', () => {
  const router = files.get('SKILL.md') ?? '';
  const routed = router
    .split('\n')
    .some(
      (line) =>
        line.includes('workflows.additionalDirectories') &&
        line.includes('references/config-global.md'),
    );
  assert.ok(
    routed,
    'SKILL.md must route workflows.additionalDirectories to references/config-global.md',
  );
});

test('the router selects global config for terminal history and cache retention', () => {
  const router = files.get('SKILL.md') ?? '';
  const frontmatter = router.slice(0, router.indexOf('---', 4));
  assert.match(frontmatter, /terminal history/i);
  assert.match(frontmatter, /scrollback/i);
  assert.match(frontmatter, /cache retention/i);
  const routed = router
    .split('\n')
    .some(
      (line) =>
        line.includes('terminal history') &&
        line.includes('`terminal`') &&
        line.includes('references/config-global.md'),
    );
  assert.ok(routed, 'SKILL.md must route terminal history to references/config-global.md');
});

test('the global config reference documents terminal settings durable facts', () => {
  const emitted = files.get('references/config-global.md') ?? '';
  const heading = '\n## Terminal history and cache retention\n';
  const sectionIndex = emitted.indexOf(heading);
  assert.notEqual(sectionIndex, -1, 'config-global.md lost its terminal settings section');
  const sectionStart = sectionIndex + heading.length;
  const nextHeadingIndex = emitted.indexOf('\n## ', sectionStart);
  assert.notEqual(nextHeadingIndex, -1, 'terminal settings must precede another section');
  const prose = emitted.slice(sectionStart, nextHeadingIndex);

  for (const key of [
    'scrollbackLines',
    'idleTtlMinutes',
    'maxHiddenSessions',
    'maxEstimatedBufferMiB',
  ]) {
    assert.match(prose, new RegExp(`\\b${key}\\b`), `terminal prose never names ${key}`);
  }
  for (const value of ['5000', '100000', '180', '10080', '4', '32', '64', '2048']) {
    assert.match(prose, new RegExp(`\\b${value}\\b`), `terminal prose never names ${value}`);
  }
  assert.match(prose, /zero/i);
  assert.match(prose, /restart/i);
  assert.match(prose, new RegExp(`${dataRoot.replaceAll('/', '\\/')}\\/config\\.yaml`));
  assert.match(prose, /\.isagi\/config\.yaml.*does not own/);
});

/**
 * Other sections and the embedded schema also mention `~` or restart behavior. Isolate this section so
 * its handwritten explanation must carry each user-facing fact on its own.
 */
test('the global config prose documents additional workflow directories without leaning on the schema', () => {
  const emitted = files.get('references/config-global.md') ?? '';
  const heading = '\n## Additional workflow directories\n';
  const sectionIndex = emitted.indexOf(heading);
  assert.notEqual(
    sectionIndex,
    -1,
    'config-global.md lost its ## Additional workflow directories section',
  );
  const sectionStart = sectionIndex + heading.length;
  const nextHeadingIndex = emitted.indexOf('\n## ', sectionStart);
  assert.notEqual(
    nextHeadingIndex,
    -1,
    'additional workflow directories must precede another section',
  );
  const prose = emitted.slice(sectionStart, nextHeadingIndex);

  assert.match(prose, /additionalDirectories/, 'prose never names additionalDirectories');
  assert.match(prose, /workflows:/, 'prose never shows the workflows nesting');
  assert.match(prose, /absolute/i, 'prose never states paths must be absolute');
  assert.match(prose, /~/, 'prose never mentions current-user ~ expansion');
  assert.match(prose, /current user/i, 'prose never limits ~ expansion to the current user');
  assert.match(prose, /priority|order/i, 'prose never states array-order precedence');
  assert.match(prose, /data[-\s]?root/i, 'prose never names the lower data-root source');
  assert.match(prose, /\.isagi\/workflows/, 'prose never names the higher project source');
  assert.match(prose, /restart/i, 'prose never states a restart is required');
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

test('the canonical skill allows precise description-driven invocation', () => {
  const router = files.get('SKILL.md') ?? '';
  assert.doesNotMatch(router, /^disable-model-invocation:/m);
  assert.doesNotMatch(router, /^metadata:/m);
  assert.match(router, /Use only when the user asks to configure Isagi/);
  assert.match(router, /Do not use for ordinary development work/);
});
