import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeCheckpointPlan, type CheckpointPlanRejectionReason } from './plan.js';

const node = { nodeId: 'phase-done', title: 'Phase done' };

function reasonOf(value: unknown, owner: { nodeId: string; title?: string } = node) {
  const result = normalizeCheckpointPlan(value, owner);
  assert.equal(result.ok, false, `expected ${JSON.stringify(value)} to be refused`);
  return result.ok ? null : result.reason;
}

describe('checkpoint plan normalization', () => {
  it('normalizes paths, sorts and deduplicates exclusions, and sorts scopes by path', () => {
    const result = normalizeCheckpointPlan(
      {
        title: '  Phase 2 completed ',
        capture: [
          { scope: 'src', directory: './src/', exclude: ['gen', 'gen/', 'b', 'a\\c'] },
          { scope: 'plan', file: 'docs/plan.md' },
        ],
      },
      node,
    );
    assert.deepEqual(result, {
      ok: true,
      value: {
        title: 'Phase 2 completed',
        scopes: [
          { scopeId: 'plan', kind: 'file', path: 'docs/plan.md', exclusions: [] },
          { scopeId: 'src', kind: 'directory', path: 'src', exclusions: ['a/c', 'b', 'gen'] },
        ],
      },
    });
  });

  it('allows an empty plan, which records only the baseline and inherits coverage', () => {
    assert.deepEqual(normalizeCheckpointPlan({ capture: [] }, node), {
      ok: true,
      value: { title: 'Phase done', scopes: [] },
    });
  });

  it('defaults the title to the node title, then the node id', () => {
    const titleOf = (owner: { nodeId: string; title?: string }) => {
      const result = normalizeCheckpointPlan({ capture: [] }, owner);
      return result.ok ? result.value.title : null;
    };
    assert.equal(titleOf({ nodeId: 'n', title: ' Static ' }), 'Static');
    assert.equal(titleOf({ nodeId: 'n', title: '   ' }), 'n');
    assert.equal(titleOf({ nodeId: 'n' }), 'n');
  });

  it('refuses every broken rule with its own reason', () => {
    const cases: [unknown, CheckpointPlanRejectionReason][] = [
      [null, 'invalid_plan_shape'],
      [[], 'invalid_plan_shape'],
      [{}, 'invalid_plan_shape'],
      [{ capture: 'src' }, 'invalid_plan_shape'],
      [{ title: 7, capture: [] }, 'invalid_title'],
      [{ title: '  ', capture: [] }, 'invalid_title'],
      [{ title: 'x'.repeat(513), capture: [] }, 'invalid_title'],
      [
        { capture: Array.from({ length: 65 }, (_, i) => ({ scope: `s${i}`, file: `f${i}` })) },
        'too_many_scopes',
      ],
      [{ capture: ['src'] }, 'invalid_scope_shape'],
      [{ capture: [{ directory: 'src' }] }, 'invalid_scope_shape'],
      [{ capture: [{ scope: 'a', directory: 'src', file: 'x' }] }, 'invalid_scope_shape'],
      [{ capture: [{ scope: 'a' }] }, 'invalid_scope_shape'],
      [{ capture: [{ scope: 'a', directory: 3 }] }, 'invalid_scope_shape'],
      [{ capture: [{ scope: 'a', file: 'x', exclude: ['y'] }] }, 'invalid_scope_shape'],
      [{ capture: [{ scope: 'a', directory: 'x', exclude: 'y' }] }, 'invalid_scope_shape'],
      [{ capture: [{ scope: 'Src', directory: 'src' }] }, 'invalid_scope_id'],
      [{ capture: [{ scope: '-a', directory: 'src' }] }, 'invalid_scope_id'],
      [{ capture: [{ scope: 'a'.repeat(65), directory: 'src' }] }, 'invalid_scope_id'],
      [
        {
          capture: [
            { scope: 'a', directory: 'src' },
            { scope: 'a', directory: 'docs' },
          ],
        },
        'duplicate_scope_id',
      ],
      [{ capture: [{ scope: 'a', directory: '../x' }] }, 'invalid_scope_path'],
      [{ capture: [{ scope: 'a', directory: '/abs' }] }, 'invalid_scope_path'],
      [{ capture: [{ scope: 'a', directory: '.' }] }, 'invalid_scope_path'],
      [{ capture: [{ scope: 'a', directory: '.git' }] }, 'git_metadata_path'],
      [{ capture: [{ scope: 'a', file: 'sub/.git/config' }] }, 'git_metadata_path'],
      [
        {
          capture: [
            {
              scope: 'a',
              directory: 'src',
              exclude: Array.from({ length: 65 }, (_, i) => `x${i}`),
            },
          ],
        },
        'too_many_exclusions',
      ],
      [{ capture: [{ scope: 'a', directory: 'src', exclude: ['../x'] }] }, 'invalid_exclusion'],
      [{ capture: [{ scope: 'a', directory: 'src', exclude: [3] }] }, 'invalid_exclusion'],
      [
        { capture: [{ scope: 'a', directory: 'src', exclude: ['vendor/.git'] }] },
        'invalid_exclusion',
      ],
      [
        {
          capture: [
            { scope: 'a', directory: 'src' },
            { scope: 'b', directory: 'src' },
          ],
        },
        'overlapping_scopes',
      ],
      [
        {
          capture: [
            { scope: 'a', directory: 'src' },
            { scope: 'b', file: 'src/index.ts' },
          ],
        },
        'overlapping_scopes',
      ],
      // Literal roots overlap even when an exclusion keeps the regions apart.
      [
        {
          capture: [
            { scope: 'a', directory: 'src', exclude: ['gen'] },
            { scope: 'b', directory: 'src/gen' },
          ],
        },
        'overlapping_scopes',
      ],
    ];
    for (const [value, reason] of cases) {
      assert.equal(reasonOf(value), reason, JSON.stringify(value).slice(0, 120));
    }
  });

  it('holds a defaulted static title to the same bound', () => {
    assert.equal(
      reasonOf({ capture: [] }, { nodeId: 'n', title: 'x'.repeat(600) }),
      'invalid_title',
    );
  });

  it('does not mistake a shared name prefix for overlap', () => {
    const result = normalizeCheckpointPlan(
      {
        capture: [
          { scope: 'a', directory: 'src' },
          { scope: 'b', directory: 'src-old' },
          { scope: 'c', file: 'srcfile' },
        ],
      },
      node,
    );
    assert.equal(result.ok, true);
  });

  it('names the scope and field of a refusal', () => {
    const result = normalizeCheckpointPlan(
      {
        capture: [
          { scope: 'ok', directory: 'a' },
          { scope: 'bad', directory: '../b' },
        ],
      },
      node,
    );
    assert.deepEqual(result, {
      ok: false,
      reason: 'invalid_scope_path',
      detail: { scopeId: 'bad', field: 'capture[1].directory', path: '../b' },
    });
  });
});
