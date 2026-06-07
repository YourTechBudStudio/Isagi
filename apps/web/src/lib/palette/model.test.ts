import assert from 'node:assert/strict';
import test from 'node:test';

import { computeStepOptions, defaultOptionIndex } from './model.js';
import type { ArgSpec } from './types.js';

const options = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'bravo', label: 'Bravo', isDefault: true },
];

test('wizard select steps can opt out of empty-query default selection', () => {
  const spec: ArgSpec = {
    kind: 'select',
    key: 'worktreeId',
    label: 'Worktree',
    defaultSelection: 'none',
    options: () => options,
  };

  assert.equal(defaultOptionIndex(spec, options), null);
});

test('wizard select steps default to explicit defaults when allowed', () => {
  const spec: ArgSpec = {
    kind: 'select',
    key: 'projectId',
    label: 'Project',
    options: () => options,
  };

  assert.equal(defaultOptionIndex(spec, options), 1);
});

test('combo create options use command-specific copy', () => {
  const spec: ArgSpec = {
    kind: 'combo',
    key: 'branch',
    label: 'Worktree',
    createHint: 'create branch',
    options: () => [],
  };

  assert.deepEqual(computeStepOptions(spec, [], 'feature/new'), [
    { value: 'feature/new', create: true, hint: 'create branch' },
  ]);
});
