import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  dedupeWorkflowSources,
  discoverOrderedWorkflowSources,
  scanWorkflowSource,
  type WorkflowDiscoverySource,
  type WorkflowFilesystemCandidate,
} from './discovery.js';

test('source deduplication preserves the highest-priority source and explicit declaration fact', () => {
  const sources: readonly WorkflowDiscoverySource[] = [
    { kind: 'core', rootPath: '/shared', explicitlyConfigured: false },
    { kind: 'additional', rootPath: '/middle', configuredIndex: 0, explicitlyConfigured: true },
    { kind: 'additional', rootPath: '/shared', configuredIndex: 1, explicitlyConfigured: true },
    {
      kind: 'project',
      projectId: 1,
      projectRoot: '/project',
      rootPath: '/middle',
      explicitlyConfigured: false,
    },
  ];

  assert.deepEqual(dedupeWorkflowSources(sources), [
    {
      kind: 'additional',
      rootPath: '/shared',
      configuredIndex: 1,
      explicitlyConfigured: true,
    },
    {
      kind: 'project',
      projectId: 1,
      projectRoot: '/project',
      rootPath: '/middle',
      explicitlyConfigured: true,
    },
  ]);
});

test('ordered discovery scans each source once and preserves precedence separately from key order', () => {
  const sources: readonly WorkflowDiscoverySource[] = [
    { kind: 'core', rootPath: '/low', explicitlyConfigured: false },
    { kind: 'additional', rootPath: '/middle', configuredIndex: 0, explicitlyConfigured: true },
    { kind: 'additional', rootPath: '/high', configuredIndex: 1, explicitlyConfigured: true },
  ];
  const calls: string[] = [];
  const candidates = new Map([
    ['/low', [candidate(sources[0]!, 'zeta'), candidate(sources[0]!, 'shared')]],
    ['/middle', [candidate(sources[1]!, 'shared')]],
    ['/high', [candidate(sources[2]!, 'alpha'), candidate(sources[2]!, 'shared')]],
  ]);

  const discovered = discoverOrderedWorkflowSources(sources, (source) => {
    calls.push(source.rootPath);
    return candidates.get(source.rootPath) ?? [];
  });

  assert.deepEqual(calls, ['/low', '/middle', '/high']);
  assert.deepEqual(
    discovered.map((entry) => entry.workflowKey),
    ['alpha', 'shared', 'zeta'],
  );
  const shared = discovered.find((entry) => entry.workflowKey === 'shared');
  assert.ok(shared);
  assert.equal(shared.winner.packageRoot, '/high/shared');
  assert.deepEqual(
    shared.shadowed.map((entry) => entry.packageRoot),
    ['/low/shared', '/middle/shared'],
  );
});

test('source scanning treats ENOENT as absent but rejects a non-directory root', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-workflow-source-scan-'));
  try {
    const missing: WorkflowDiscoverySource = {
      kind: 'core',
      rootPath: join(root, 'missing'),
      explicitlyConfigured: false,
    };
    assert.throws(() => scanWorkflowSource(missing), { code: 'ENOENT' });

    const fileRoot = join(root, 'not-a-directory');
    writeFileSync(fileRoot, 'not a workflow collection\n');
    assert.throws(
      () => scanWorkflowSource({ kind: 'core', rootPath: fileRoot, explicitlyConfigured: false }),
      { code: 'ENOTDIR' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function candidate(
  source: WorkflowDiscoverySource,
  workflowKey: string,
): WorkflowFilesystemCandidate {
  return { workflowKey, packageRoot: join(source.rootPath, workflowKey), source };
}
