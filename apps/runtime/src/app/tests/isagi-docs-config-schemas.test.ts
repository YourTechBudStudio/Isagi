import assert from 'node:assert/strict';
import { posix } from 'node:path';
import test from 'node:test';

import {
  workflowBuilderVersion,
  workflowSdkVersion,
  workflowVerifierVersion,
} from '@yourtechbudstudio/isagi-workflow-verifier/receipt';
import { Schema } from 'effect';
import { parse } from 'yaml';

import {
  configSchemaReferenceSources,
  isagiDocsContentSources,
  isagiDocsName,
  isagiDocsPackageFiles,
  workflowScaffoldSources,
} from '../../harnesses/testing.js';
import { projectConfigSchema } from '../../projects/testing.js';
import { runtimeConfigSchema } from '../../runtime-config/testing.js';

const dataRoot = '/Users/example/.isagi';
const files = isagiDocsPackageFiles(dataRoot);
const handwritten = [...files];

/** Every placeholder the generator substitutes, and the text it must expand to. */
const substitutions = {
  DATA_ROOT: dataRoot,
  SDK_VERSION: workflowSdkVersion,
  VERIFIER_VERSION: workflowVerifierVersion,
  BUILDER_VERSION: workflowBuilderVersion,
} as const;

/** Which template carries which placeholder; every other template carries none. */
const templateTokens: Readonly<Record<string, readonly (keyof typeof substitutions)[]>> = {
  'SKILL.md': ['DATA_ROOT'],
  'workflow-package.md': ['DATA_ROOT', 'SDK_VERSION', 'VERIFIER_VERSION', 'BUILDER_VERSION'],
};

const emittedAs = (name: string) => (name === 'SKILL.md' ? name : `references/${name}`);

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
  for (const [name, tokens] of Object.entries(templateTokens)) {
    const template = isagiDocsContentSources.get(name);
    assert.ok(template, `missing skill content ${name}`);
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

  for (const [name, tokens] of Object.entries(templateTokens)) {
    const emitted = files.get(emittedAs(name));
    assert.ok(emitted, `${name} was not emitted as ${emittedAs(name)}`);
    for (const token of tokens) {
      assert.equal(
        emitted.includes(substitutions[token]),
        true,
        `${emittedAs(name)} is missing the text substituted for {{${token}}}`,
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
      ...[...isagiDocsContentSources.keys()]
        .filter((name) => name !== 'SKILL.md')
        .map((name) => `references/${name}`),
      'references/config-global.schema.ts',
      'references/config-project.schema.ts',
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

test('skill metadata preserves automatic, focused invocation', () => {
  const router = files.get('SKILL.md') ?? '';
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(router);
  assert.ok(frontmatter, 'missing skill frontmatter');
  const metadata = parse(frontmatter[1]!) as Record<string, unknown>;
  assert.equal(metadata.name, isagiDocsName);
  assert.equal(typeof metadata.description, 'string');
  assert.ok(String(metadata.description).length > 0);
  assert.equal(metadata['disable-model-invocation'], undefined);
  assert.match(String(metadata.description), /Isagi workflows/);
  assert.match(String(metadata.description), /Do not use for ordinary development work/);
});

test('all local reference links resolve within the generated skill and all files are reachable', () => {
  const reached = new Set<string>();
  const visit = (path: string) => {
    if (reached.has(path)) return;
    reached.add(path);
    const source = files.get(path);
    assert.ok(source !== undefined, `missing ${path}`);
    if (!path.endsWith('.md')) return;
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = match[1]!;
      if (/^(?:https?:|#)/.test(href)) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), href.split('#')[0]!));
      assert.ok(
        !target.startsWith('../') && !posix.isAbsolute(target),
        `${path}: escaped link ${href}`,
      );
      if (href.endsWith('/')) {
        const children = [...files.keys()].filter((key) => key.startsWith(target));
        assert.ok(children.length > 0, `${path}: empty directory link ${href}`);
        children.forEach(visit);
      } else {
        assert.ok(files.has(target), `${path}: broken link ${href}`);
        visit(target);
      }
    }
  };
  visit('SKILL.md');
  assert.deepEqual([...reached].sort(), [...files.keys()].sort());
});

test('on-demand configuration schemas preserve the authoritative source bytes', () => {
  assert.equal(
    files.get('references/config-global.schema.ts'),
    configSchemaReferenceSources['runtime-config.schema.ts'],
  );
  assert.equal(
    files.get('references/config-project.schema.ts'),
    configSchemaReferenceSources['project-config.schema.ts'],
  );
});

/**
 * The schema references carry source bytes verbatim; their guides declare them authoritative
 * over prose. A new *top-level* section is the gap. The router would keep silently
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

test('the router states where global, project and worktree config live', () => {
  const router = files.get('SKILL.md') ?? '';
  assert.ok(router.includes(`${dataRoot}/config.yaml`), 'SKILL.md never names the global config');
  assert.ok(
    router.includes(`${dataRoot}/workflows/<key>/`),
    'SKILL.md never names global workflows',
  );
  assert.match(router, /`<project root>\/\.isagi\/config\.yaml`.*`worktrees\.hooks`/);
  assert.match(router, /`<worktree>\/\.isagi\/config\.yaml`.*`commands`/);
  assert.match(
    router,
    /ISAGI_DATA_DIR/,
    'SKILL.md never explains which runtime owns the data root',
  );
});

/**
 * Prose defers to the schemas for fields and defaults, so the YAML it shows must be config the
 * schemas accept: a reader copies these blocks verbatim.
 */
test('every YAML example in a config reference decodes against its schema', () => {
  let checked = 0;
  for (const [path, source] of files) {
    if (!path.endsWith('.md')) continue;
    for (const match of source.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)) {
      const document = parse(match[1]!) as Record<string, unknown>;
      const schema =
        'commands' in document || 'worktrees' in document
          ? projectConfigSchema
          : runtimeConfigSchema;
      const decoded = Schema.decodeUnknownExit(schema as Schema.Codec<unknown>)(document);
      assert.ok(
        decoded._tag === 'Success',
        `${path}: a YAML example does not decode:\n${match[1]}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'expected YAML examples in the skill');
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
  const workflows = files.get('references/workflow-package.md') ?? '';
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
