import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { disabledHarnessPolicy } from '../runtime-config/index.js';
import { publishDocsTarget, reconcileDocs, type PublicationFileSystem } from './docs-reconciler.js';
const probes = {
  pi: { _tag: 'Missing', command: 'pi' },
  opencode: { _tag: 'Missing', command: 'opencode' },
  claude: { _tag: 'Missing', command: 'claude' },
  codex: { _tag: 'Missing', command: 'codex' },
} as const;
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
        node: { _tag: 'Missing' as const, command: 'node' },
        packageManagers: {
          pnpm: { _tag: 'Missing' as const, command: 'pnpm' },
          npm: { _tag: 'Missing' as const, command: 'npm' },
          bun: { _tag: 'Missing' as const, command: 'bun' },
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
          node: { _tag: 'Missing', command: 'node' },
          packageManagers: {
            pnpm: { _tag: 'Missing', command: 'pnpm' },
            npm: { _tag: 'Missing', command: 'npm' },
            bun: { _tag: 'Missing', command: 'bun' },
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
    publishDocsTarget(destination, files, fileSystem).pipe(Effect.either),
  );
  assert.equal(result._tag, 'Left');
  assert.equal(result._tag === 'Left' ? result.left.reason : null, 'publication_failed');
  assert.equal(entries.get(destination), 'previous content');
  assert.equal(
    [...entries.keys()].some((path) => path.includes('.isagi-docs-backup-')),
    false,
  );
});
