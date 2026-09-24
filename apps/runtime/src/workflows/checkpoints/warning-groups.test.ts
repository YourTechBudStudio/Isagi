import assert from 'node:assert/strict';
import test from 'node:test';

import type { CheckpointEntry } from './resolve.js';
import { warningGroupsOf } from './warning-groups.js';

const own = 'wcp_own';
const parent = 'wcp_parent';

function warning(
  reason: Extract<CheckpointEntry, { kind: 'warning' }>['reason'],
  path: string | null,
  observedBy = own,
  detail: Readonly<Record<string, string | number>> | null = null,
): CheckpointEntry {
  return { kind: 'warning', reason, path, scopeId: null, detail, observedBy };
}

test('groups only this layer, in vocabulary order, with folded truncation and five samples', () => {
  const dirty = Array.from({ length: 7 }, (_, index) => `dirty/${index}.txt`);
  const groups = warningGroupsOf(
    [
      {
        kind: 'scope',
        scopeId: 'src',
        scopeKind: 'directory',
        path: 'src',
        exclusions: [],
        capturedBy: own,
      },
      warning('special_file_skipped', 'src/fifo', parent),
      warning('symlink_skipped', 'src/inherited', parent),
      warning('symlink_skipped', 'src/own'),
      warning('ignored_paths_not_surveyed', null),
      ...dirty.map((path) => warning('uncaptured_dirty_path', path)),
      warning('warnings_truncated', null, own, { omitted: 12 }),
    ],
    own,
  );
  assert.deepEqual(groups, [
    { reason: 'uncaptured_dirty_path', count: 19, samples: dirty.slice(0, 5) },
    { reason: 'ignored_paths_not_surveyed', count: 1, samples: [] },
    { reason: 'symlink_skipped', count: 1, samples: ['src/own'] },
  ]);
});

test('a layer that observed nothing has no groups, whatever it inherited', () => {
  assert.deepEqual(warningGroupsOf([warning('symlink_skipped', 'a', parent)], own), []);
});
