import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  discoverOrderedWorkflowSources,
  scanWorkflowSource,
  type WorkflowDiscoverySource,
  type WorkflowFilesystemCandidate,
} from './discovery.js';

test('ordered discovery scans each source once and preserves precedence separately from key order', () => {
  const sources: readonly WorkflowDiscoverySource[] = [
    { kind: 'global', rootPath: '/low' },
    { kind: 'global', rootPath: '/middle' },
    { kind: 'global', rootPath: '/high' },
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
      kind: 'global',
      rootPath: join(root, 'missing'),
    };
    assert.deepEqual(scanWorkflowSource(missing), []);

    const fileRoot = join(root, 'not-a-directory');
    writeFileSync(fileRoot, 'not a workflow collection\n');
    assert.throws(() => scanWorkflowSource({ kind: 'global', rootPath: fileRoot }), {
      code: 'ENOTDIR',
    });
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
