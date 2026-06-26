import assert from 'node:assert/strict';
import test from 'node:test';

import { inputFlowSelectableLength } from '../../components/input-flow/index.js';
import { commandStepToInputFlowScreen } from './input-flow.js';
import type { StepData } from './machine.js';
import type { ArgSpec } from './types.js';

test('command combo args adapt to shared input-flow create options', () => {
  const spec: ArgSpec = {
    kind: 'combo',
    key: 'branch',
    label: 'Branch',
    createHint: 'new branch',
    options: () => [{ value: 'main', label: 'main' }],
  };
  const screen = commandStepToInputFlowScreen({
    spec,
    stepData: optionStep([{ value: 'main', label: 'main' }], 'combo'),
    query: 'feature/refactor',
  });

  assert.equal(screen.kind, 'combo');
  assert.equal(screen.label, 'Branch');
  assert.equal(screen.options[0]?.value, 'feature/refactor');
  assert.equal(screen.options[0]?.create, true);
  assert.equal(screen.options[0]?.hint, 'new branch');
  assert.equal(inputFlowSelectableLength(screen), 1);
});

test('command review args adapt to shared input-flow review screens', () => {
  const spec: ArgSpec = {
    kind: 'review',
    key: 'confirm',
    label: 'Confirm',
    load: () => null,
  };
  const screen = commandStepToInputFlowScreen({
    spec,
    stepData: {
      kind: 'review',
      content: {
        title: 'Delete checkout?',
        body: 'This removes the checkout.',
        items: [{ label: 'feature/remove-me' }],
        choices: [{ value: 'delete', label: 'Delete', intent: 'danger' }],
      },
      loading: false,
      error: null,
      attemptId: 1,
    },
    query: '',
  });

  assert.equal(screen.kind, 'review');
  assert.equal(screen.content?.choices[0]?.intent, 'danger');
  assert.equal(inputFlowSelectableLength(screen), 1);
});

test('stale command path screens are not selectable', () => {
  const spec: ArgSpec = { kind: 'path', key: 'path', label: 'Path' };
  const screen = commandStepToInputFlowScreen({
    spec,
    stepData: {
      kind: 'path',
      suggestions: [{ label: 'repo', path: '/repo' }],
      suggestionsQuery: '/old',
      loading: true,
      error: null,
      attemptId: 1,
    },
    query: '/repo',
  });

  assert.equal(screen.kind, 'path');
  assert.equal(screen.stale, true);
  assert.equal(inputFlowSelectableLength(screen), 0);
});

function optionStep(
  options: Extract<StepData, { kind: 'select' | 'combo' }>['options'],
  kind: 'select' | 'combo' = 'select',
): StepData {
  return {
    kind,
    options,
    loading: false,
    error: null,
    attemptId: 1,
  };
}
