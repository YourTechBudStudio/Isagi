import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultOptionIndex } from './model.js';
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
