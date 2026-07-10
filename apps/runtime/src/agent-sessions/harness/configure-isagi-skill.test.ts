import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';

import { projectConfigSchema } from '../../project-config/project-config.schema.js';
import {
  configSchemaReferenceSources,
  configureIsagiSkillContentSources,
  runtimePackageVersion,
} from '../../runtime-assets.js';
import { runtimeConfigSchema } from '../../runtime-config/runtime-config.schema.js';
import {
  configureIsagiSkillArtifactPaths,
  configureIsagiSkillName,
  configureIsagiSkillPackageFiles,
  configureIsagiSkillVerifyCommand,
  writeConfigureIsagiSkillArtifacts,
} from './configure-isagi-skill.js';

const dataRoot = '/Users/example/.isagi';
const files = configureIsagiSkillPackageFiles(dataRoot);
const handwritten = [...files].filter(([path]) => !path.startsWith('references/sdk/'));

/** Mirrors the generator's own trimming so a value assertion compares like with like. */
const trimTrailingNewline = (source: string) => source.replace(/\n+$/, '');

/** Every placeholder the generator substitutes, and the text it must expand to. */
const substitutions = {
  VERSION: runtimePackageVersion,
  DATA_ROOT: dataRoot,
  VERIFY_COMMAND: configureIsagiSkillVerifyCommand,
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
    tokens: ['DATA_ROOT', 'VERIFY_COMMAND'],
  },
} as const satisfies Record<
  keyof typeof configureIsagiSkillContentSources,
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
    const template = configureIsagiSkillContentSources[name as keyof typeof templates];
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
    ],
  );
  assert.equal(files.has('references/sdk/index.ts'), true);
});

test('the skill name matches its frontmatter and its directory', () => {
  const router = files.get('SKILL.md') ?? '';
  assert.match(router, new RegExp(`^name: ${configureIsagiSkillName}$`, 'm'));

  const artifacts = configureIsagiSkillArtifactPaths(dataRoot);
  assert.equal(basename(artifacts.skillDirectory), configureIsagiSkillName);
  assert.equal(dirname(artifacts.skillDirectory), artifacts.skillScanDirectory);
});

test('the documented verify command uses the runtime URL curl contract', () => {
  assert.match(configureIsagiSkillVerifyCommand, /curl -sS/);
  assert.match(configureIsagiSkillVerifyCommand, /\$ISAGI_RUNTIME_URL\/api\/v1\/workflows\/verify/);
  assert.match(configureIsagiSkillVerifyCommand, /"workflowKey":"<workflow-key>"/);
});

test('the router and the SDK reference read as a skill package', () => {
  const router = files.get('SKILL.md') ?? '';
  assert.match(router, new RegExp(`^  version: "${runtimePackageVersion}"$`, 'm'));
  assert.equal(router.includes(`${dataRoot}/config.yaml`), true);
  assert.equal(router.includes(`${dataRoot}/workflows/<key>/index.ts`), true);

  const sdk = files.get('references/sdk/index.ts') ?? '';
  assert.match(sdk, /export function defineWorkflow/);
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
 * OpenCode scans `skillScanDirectory` recursively for any `SKILL.md`, and the Claude wrapper holds a
 * second copy of the very same package. The wrapper is safe only while it sits outside that scan
 * root; today that holds by path construction alone. A refactor that moved the wrapper under
 * `skills/` would put two `configure-isagi` skills in front of every OpenCode session with nothing
 * failing. This asserts the structural half of the duplicate-discovery guard. The runtime
 * observation - that OpenCode really does list the skill once - remains a manual check.
 */
test('the Claude wrapper sits outside the OpenCode scan root', () => {
  const { claudeSkillWorkspaceDirectory, skillScanDirectory } =
    configureIsagiSkillArtifactPaths(dataRoot);

  const descent = relative(skillScanDirectory, claudeSkillWorkspaceDirectory);
  assert.equal(
    descent.startsWith('..') || isAbsolute(descent),
    true,
    'the Claude wrapper is inside the directory OpenCode scans recursively',
  );
});

test('skill references do not carry generated contents sections', () => {
  for (const [path, source] of handwritten) {
    if (path === 'SKILL.md') continue;
    assert.doesNotMatch(source, /^## Contents$/m, `${path} includes a contents section`);
  }
});

test('skill prose is portable and self-contained', () => {
  for (const [path, source] of handwritten) {
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
    const artifacts = configureIsagiSkillArtifactPaths(root);
    const staleSkill = resolve(artifacts.skillScanDirectory, 'isagi-configure');
    const staleClaudeSkill = resolve(
      artifacts.claudeSkillWorkspaceDirectory,
      '.claude',
      'skills',
      'isagi-configure',
    );
    for (const stale of [staleSkill, staleClaudeSkill]) {
      mkdirSync(stale, { recursive: true });
      writeFileSync(resolve(stale, 'SKILL.md'), '---\nname: isagi-configure\n---\n', 'utf8');
    }

    writeConfigureIsagiSkillArtifacts(root);

    assert.equal(existsSync(staleSkill), false, 'stale skill survived under the shared scan root');
    assert.equal(existsSync(staleClaudeSkill), false, 'stale skill survived in the Claude wrapper');
    assert.equal(existsSync(resolve(artifacts.skillDirectory, 'SKILL.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('both harness trees receive byte-identical skill files', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-skill-trees-'));
  try {
    const artifacts = writeConfigureIsagiSkillArtifacts(root);
    const claudeSkillDirectory = resolve(
      artifacts.claudeSkillWorkspaceDirectory,
      '.claude',
      'skills',
      'configure-isagi',
    );

    for (const [path] of configureIsagiSkillPackageFiles(root)) {
      assert.equal(
        readFileSync(resolve(artifacts.skillDirectory, path), 'utf8'),
        readFileSync(resolve(claudeSkillDirectory, path), 'utf8'),
        `${path} differs between the canonical and Claude trees`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
