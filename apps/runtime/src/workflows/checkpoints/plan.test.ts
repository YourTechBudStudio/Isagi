import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCheckpointPlan } from './plan.js';

function refusal(plan: unknown): string {
  const result = normalizeCheckpointPlan(plan);
  assert.equal(result.ok, false, `expected ${JSON.stringify(plan)} to be refused`);
  return result.ok ? '' : result.message;
}

test('a plan is normalized: paths cleaned, exclusions sorted and deduplicated', () => {
  const result = normalizeCheckpointPlan({
    capture: [
      { scope: 'notes', directory: './notes/', exclude: ['b', 'a', 'a/'] },
      { scope: 'tool', file: 'bin\\tool.sh' },
    ],
  });
  assert.deepEqual(result, {
    ok: true,
    value: {
      scopes: [
        { scope: 'notes', kind: 'directory', path: 'notes', exclude: ['a', 'b'] },
        { scope: 'tool', kind: 'file', path: 'bin/tool.sh', exclude: [] },
      ],
    },
  });
  assert.deepEqual(normalizeCheckpointPlan({ capture: [] }), { ok: true, value: { scopes: [] } });
});

test('every rule refuses rather than repairs', () => {
  assert.match(refusal(null), /capture/);
  assert.match(refusal({ capture: [{ scope: 'a', directory: 'x', file: 'y' }] }), /exactly one/);
  assert.match(refusal({ capture: [{ scope: 'Bad', directory: 'x' }] }), /must match/);
  assert.match(
    refusal({
      capture: [
        { scope: 'a', directory: 'x' },
        { scope: 'a', directory: 'y' },
      ],
    }),
    /used twice/,
  );
  for (const path of ['/abs', '../up', 'a/../b', 'a/b/..', 'C:\\x', '.', '']) {
    assert.match(refusal({ capture: [{ scope: 'a', directory: path }] }), /relative path/);
  }
  assert.match(refusal({ capture: [{ scope: 'a', directory: 'x/.git/hooks' }] }), /\.git/);
  assert.match(refusal({ capture: [{ scope: 'a', file: 'x', exclude: ['y'] }] }), /exclude/);
  assert.match(
    refusal({ capture: [{ scope: 'a', directory: 'x', exclude: ['../y'] }] }),
    /exclude/,
  );
  assert.match(
    refusal({
      capture: [
        { scope: 'a', directory: 'x' },
        { scope: 'b', file: 'x/y.md' },
      ],
    }),
    /overlap/,
  );
  assert.match(
    refusal({
      capture: Array.from({ length: 65 }, (_, index) => ({
        scope: `s${index}`,
        file: `f${index}`,
      })),
    }),
    /at most 64/,
  );
});
