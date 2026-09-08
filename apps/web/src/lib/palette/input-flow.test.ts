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

function pathStep(
  overrides: Partial<Extract<StepData, { kind: 'path' }>> = {},
): Extract<StepData, { kind: 'path' }> {
  return {
    kind: 'path',
    suggestions: [{ label: 'repo', path: '/repo' }],
    suggestionsQuery: '/repo',
    loading: false,
    error: null,
    attemptId: 1,
    highlightedIndex: null,
    ...overrides,
  };
}

const pathSpec: ArgSpec = { kind: 'path', key: 'path', label: 'Path' };

test('stale command path screens are not selectable', () => {
  const screen = commandStepToInputFlowScreen({
    spec: pathSpec,
    stepData: pathStep({ suggestionsQuery: '/old', loading: true }),
    query: '/repo',
  });

  assert.equal(screen.kind, 'path');
  assert.equal(screen.stale, true);
  assert.equal(inputFlowSelectableLength(screen), 0);
});

test('the path screen never carries a highlight of its own', () => {
  // Selection is injected at render by `withSelectedIndex`; the projection is
  // selection-free so there is exactly one place the machine's index enters.
  const screen = commandStepToInputFlowScreen({
    spec: pathSpec,
    stepData: pathStep({ highlightedIndex: 0 }),
    query: '/repo',
  });

  assert.equal(screen.kind, 'path');
  assert.equal(screen.selectedIndex, null);
});

test('enterIntent is accept when a fresh highlight resolves', () => {
  const screen = commandStepToInputFlowScreen({
    spec: pathSpec,
    stepData: pathStep({ highlightedIndex: 0 }),
    query: '/repo',
  });

  assert.equal(screen.kind, 'path');
  assert.equal(screen.enterIntent, 'accept');
});

test('enterIntent is accept even when the highlighted path equals the buffer', () => {
  // Deliberate: navigating onto a row is still browsing, so Enter fills it and a
  // second Enter submits. The click rule differs and submits immediately.
  // Freshness compares the raw query — the identity the request was issued under
  // — while the buffer the user sees and submits is trimmed, so the rows here are
  // fresh against '/repo ' and the equal path is '/repo'.
  const screen = commandStepToInputFlowScreen({
    spec: pathSpec,
    stepData: pathStep({ suggestionsQuery: '/repo ', highlightedIndex: 0 }),
    query: '/repo ',
  });

  assert.equal(screen.kind, 'path');
  assert.equal(screen.stale, false);
  assert.equal(screen.value, '/repo');
  assert.equal(screen.enterIntent, 'accept');
});

test('enterIntent is submit with no highlight and a non-empty buffer', () => {
  for (const stepData of [
    pathStep(),
    pathStep({ loading: true }),
    pathStep({ suggestions: [], error: 'unreachable' }),
    // A stale result cannot be acted on, so Enter still targets what was typed.
    pathStep({ suggestionsQuery: '/old', highlightedIndex: 0 }),
  ]) {
    const screen = commandStepToInputFlowScreen({ spec: pathSpec, stepData, query: '/repo' });
    assert.equal(screen.kind, 'path');
    assert.equal(screen.enterIntent, 'submit');
  }
});

test('enterIntent is none for an empty buffer', () => {
  const screen = commandStepToInputFlowScreen({
    spec: pathSpec,
    stepData: pathStep({ suggestions: [], suggestionsQuery: '' }),
    query: '   ',
  });

  assert.equal(screen.kind, 'path');
  assert.equal(screen.enterIntent, 'none');
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
