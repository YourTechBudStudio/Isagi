import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { harnessDefinition } from '../agent-sessions/harness/definitions.js';
import { isagiDocsPackageFiles } from '../agent-sessions/harness/isagi-docs.js';
import { disabledHarnessPolicy } from '../runtime-config/index.js';
import {
  docsReconciliationFingerprint,
  publishDocsTargets,
  reconcileDocs,
  type PublicationFileSystem,
} from './docs-reconciler.js';
const probes = {
  pi: { _tag: 'Missing', command: 'pi' },
  opencode: { _tag: 'Missing', command: 'opencode' },
  claude: { _tag: 'Missing', command: 'claude' },
  codex: { _tag: 'Missing', command: 'codex' },
} as const;

function piInput(root: string, installIsagiDocs: boolean) {
  const home = join(root, 'home');
  return {
    dataRoot: root,
    policy: {
      ...disabledHarnessPolicy,
      pi: { enabled: installIsagiDocs, installIsagiDocs },
    },
    policyRevision: 'r1',
    inventoryGeneration: 1,
    inventory: {
      environment: { _tag: 'Available' as const, values: { HOME: home } },
      harnesses: probes,
    },
  };
}

test('Docs installation follows intent despite missing executables and replaces exact-name content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-docs-reconcile-'));
  try {
    const home = join(root, 'home');
    const policy = { ...disabledHarnessPolicy, codex: { enabled: true, installIsagiDocs: true } };
    const input = {
      dataRoot: root,
      policy,
      policyRevision: 'r1',
      inventoryGeneration: 1,
      inventory: {
        environment: {
          _tag: 'Available' as const,
          values: { HOME: home, CODEX_HOME: join(home, '.codex') },
        },
        harnesses: probes,
      },
    };
    let result = await Effect.runPromise(reconcileDocs(input));
    assert.equal(result.results.find((r) => r.harness === 'codex')?.action, 'installed');
    const skill = join(home, '.codex', 'skills', 'isagi-docs', 'SKILL.md');
    writeFileSync(skill, 'user edit');
    result = await Effect.runPromise(reconcileDocs(input));
    assert.equal(result.results.find((r) => r.harness === 'codex')?.action, 'replaced');
    assert.match(readFileSync(skill, 'utf8'), /name: isagi-docs/);
    assert.match(
      readFileSync(join(home, '.codex', 'skills', 'isagi-docs', 'agents', 'openai.yaml'), 'utf8'),
      /allow_implicit_invocation: false/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi installs and replaces one prompt router while retiring the reserved legacy skill', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-docs-pi-migration-'));
  try {
    const input = piInput(root, true);
    const current = join(root, 'home', '.pi', 'agent', 'prompts', 'isagi-docs.md');
    const legacy = join(root, 'home', '.pi', 'agent', 'skills', 'isagi-docs');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'SKILL.md'), 'legacy skill');

    let result = await Effect.runPromise(reconcileDocs(input));
    assert.equal(result.results.find((entry) => entry.harness === 'pi')?.action, 'installed');
    assert.equal(existsSync(legacy), false);
    assert.equal(readFileSync(current, 'utf8').match(/\$ARGUMENTS/g)?.length, 1);

    writeFileSync(current, 'previous router');
    result = await Effect.runPromise(reconcileDocs(input));
    assert.equal(result.results.find((entry) => entry.harness === 'pi')?.action, 'replaced');
    assert.equal(readFileSync(current, 'utf8').match(/\$ARGUMENTS/g)?.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('disabled Pi docs installation performs no install or legacy migration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-docs-pi-disabled-'));
  try {
    const input = piInput(root, false);
    const current = join(root, 'home', '.pi', 'agent', 'prompts', 'isagi-docs.md');
    const legacy = join(root, 'home', '.pi', 'agent', 'skills', 'isagi-docs');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'SKILL.md'), 'legacy skill');

    const result = await Effect.runPromise(reconcileDocs(input));
    assert.equal(result.results.find((entry) => entry.harness === 'pi')?.action, 'untouched');
    assert.equal(existsSync(current), false);
    assert.equal(readFileSync(join(legacy, 'SKILL.md'), 'utf8'), 'legacy skill');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('docs fingerprint covers definition-owned projections and resolved current and legacy targets', () => {
  const root = '/tmp/isagi-fingerprint';
  const defaultFingerprint = docsReconciliationFingerprint(piInput(root, true));
  const configuredFingerprint = docsReconciliationFingerprint({
    ...piInput(root, true),
    inventory: {
      ...piInput(root, true).inventory,
      environment: {
        _tag: 'Available' as const,
        values: { HOME: join(root, 'home'), PI_CODING_AGENT_DIR: '/configured/pi' },
      },
    },
  });
  assert.notEqual(defaultFingerprint, configuredFingerprint);
});
test('failed environment capture blocks every requested publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-docs-env-failed-'));
  try {
    const policy = {
      ...disabledHarnessPolicy,
      pi: { enabled: true, installIsagiDocs: true },
      claude: { enabled: true, installIsagiDocs: true },
    };
    const result = await Effect.runPromise(
      reconcileDocs({
        dataRoot: root,
        policy,
        policyRevision: 'r1',
        inventoryGeneration: 1,
        inventory: {
          environment: {
            _tag: 'ProbeFailed',
            values: { HOME: join(root, 'fallback') },
            diagnostic: 'capture failed',
          },
          harnesses: probes,
        },
      }),
    );
    assert.equal(result.outcome, 'failed');
    assert.equal(result.results.filter((r) => r.reason === 'environment_capture_failed').length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed staged publication restores the previous exact-name target', async () => {
  const destination = '/home/isagi-docs';
  const files = new Map<string, string>([['SKILL.md', 'new content']]);
  const entries = new Map<string, string>([[destination, 'previous content']]);
  let failStagePublish = true;
  const fileSystem: PublicationFileSystem = {
    exists: (path) => entries.has(path),
    copy: (source, target) => {
      const value = entries.get(source);
      if (value === undefined) throw new Error(`missing ${source}`);
      entries.set(target, value);
    },
    mkdir: () => undefined,
    readdir: () => [],
    rename: (source, target) => {
      if (source.includes('.isagi-docs-stage-') && target === destination && failStagePublish) {
        failStagePublish = false;
        throw new Error('publish failed');
      }
      const value = entries.get(source);
      if (value === undefined) throw new Error(`missing ${source}`);
      entries.delete(source);
      entries.set(target, value);
    },
    remove: (path) => {
      entries.delete(path);
      for (const key of [...entries.keys()]) if (key.startsWith(`${path}/`)) entries.delete(key);
    },
    write: (path, content) => {
      entries.set(path.split('/SKILL.md')[0]!, content);
    },
  };
  const result = await Effect.runPromise(
    publishDocsTargets({ destination, legacyDestinations: [], files }, fileSystem).pipe(
      Effect.either,
    ),
  );
  assert.equal(result._tag, 'Left');
  assert.equal(result._tag === 'Left' ? result.left.reason : null, 'publication_failed');
  assert.equal(entries.get(destination), 'previous content');
  assert.equal(
    [...entries.keys()].some((path) => path.includes('.isagi-docs-backup-')),
    false,
  );
});

test('failed current publication restores both the prior current and reserved legacy targets', async () => {
  const destination = '/home/prompts/isagi-docs.md';
  const legacy = '/home/skills/isagi-docs';
  const entries = new Map<string, string>([
    [destination, 'previous router'],
    [legacy, 'previous skill'],
  ]);
  let failStagePublish = true;
  const fileSystem = memoryPublicationFileSystem(entries, {
    rename: (source, target) => {
      if (source.includes('.isagi-docs-stage-') && target === destination && failStagePublish) {
        failStagePublish = false;
        throw new Error('publish failed');
      }
    },
  });

  const result = await Effect.runPromise(
    publishDocsTargets(
      {
        destination,
        legacyDestinations: [legacy],
        files: new Map([['', 'new router']]),
      },
      fileSystem,
    ).pipe(Effect.either),
  );

  assert.equal(result._tag, 'Left');
  assert.equal(entries.get(destination), 'previous router');
  assert.equal(entries.get(legacy), 'previous skill');
  assert.equal(
    [...entries.keys()].some((path) => path.includes('.isagi-docs-')),
    false,
  );
});

test('failed legacy cleanup rolls back both the new publication and legacy retirement', async () => {
  const destination = '/home/prompts/isagi-docs.md';
  const legacy = '/home/skills/isagi-docs';
  const entries = new Map<string, string>([
    [destination, 'previous router'],
    [legacy, 'previous skill'],
  ]);
  let failLegacyCleanup = true;
  const fileSystem = memoryPublicationFileSystem(entries, {
    remove: (path) => {
      if (path.includes('-legacy-') && failLegacyCleanup) {
        failLegacyCleanup = false;
        throw new Error('legacy cleanup failed');
      }
    },
  });

  const result = await Effect.runPromise(
    publishDocsTargets(
      {
        destination,
        legacyDestinations: [legacy],
        files: new Map([['', 'new router']]),
      },
      fileSystem,
    ).pipe(Effect.either),
  );

  assert.equal(result._tag, 'Left');
  assert.equal(entries.get(destination), 'previous router');
  assert.equal(entries.get(legacy), 'previous skill');
  assert.equal(
    [...entries.keys()].some((path) => path.includes('.isagi-docs-')),
    false,
  );
});

// Definitions own the projection from the canonical package to each native publication format.
const renderDataRoot = '/tmp/isagi-render';
const canonicalDocs = isagiDocsPackageFiles(renderDataRoot);

test('Pi and OpenCode definitions render explicit routers with one argument placeholder', () => {
  for (const harness of ['pi', 'opencode'] as const) {
    const rendered = harnessDefinition(harness).docs.project({
      dataRoot: renderDataRoot,
      canonicalFiles: canonicalDocs,
    });
    assert.equal(rendered.size, 1);
    const router = rendered.get('') ?? '';
    assert.ok(
      router.includes(resolve(renderDataRoot, 'skills', 'shared', 'isagi-docs', 'SKILL.md')),
      `${harness} router must reference the canonical SKILL.md path`,
    );
    assert.match(router, /follow its references/);
    assert.equal(router.match(/\$ARGUMENTS/g)?.length, 1);
  }
});

test('Claude receives the canonical package verbatim and manual-only', () => {
  const rendered = harnessDefinition('claude').docs.project({
    dataRoot: renderDataRoot,
    canonicalFiles: canonicalDocs,
  });
  for (const [path, content] of canonicalDocs)
    assert.equal(rendered.get(path), content, `claude dropped or altered ${path}`);
  assert.match(rendered.get('SKILL.md') ?? '', /^disable-model-invocation: true$/m);
});

test('Codex receives the canonical package plus a manual-only policy file', () => {
  const rendered = harnessDefinition('codex').docs.project({
    dataRoot: renderDataRoot,
    canonicalFiles: canonicalDocs,
  });
  for (const [path, content] of canonicalDocs)
    assert.equal(rendered.get(path), content, `codex dropped or altered ${path}`);
  assert.match(rendered.get('SKILL.md') ?? '', /^disable-model-invocation: true$/m);
  assert.match(rendered.get('agents/openai.yaml') ?? '', /allow_implicit_invocation: false/);
});

function memoryPublicationFileSystem(
  entries: Map<string, string>,
  failures: {
    readonly rename?: ((source: string, target: string) => void) | undefined;
    readonly remove?: ((path: string) => void) | undefined;
  },
): PublicationFileSystem {
  const parents = new Set(['/home', '/home/prompts', '/home/skills']);
  return {
    exists: (path) => entries.has(path) || parents.has(path),
    copy: (source, target) => {
      const value = entries.get(source);
      if (value === undefined) throw new Error(`missing ${source}`);
      entries.set(target, value);
    },
    mkdir: (path) => {
      parents.add(path);
    },
    readdir: (path) =>
      [...entries.keys()]
        .filter((entry) => entry.startsWith(`${path}/`))
        .map((entry) => entry.slice(path.length + 1).split('/')[0]!),
    rename: (source, target) => {
      failures.rename?.(source, target);
      const value = entries.get(source);
      if (value === undefined) throw new Error(`missing ${source}`);
      entries.delete(source);
      entries.set(target, value);
    },
    remove: (path) => {
      failures.remove?.(path);
      entries.delete(path);
      for (const key of [...entries.keys()]) if (key.startsWith(`${path}/`)) entries.delete(key);
    },
    write: (path, content) => {
      entries.set(path, content);
    },
  };
}
