import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowQuestionSpecDto } from '@isagi/contracts';

import { paletteCopy } from '../../copy/index.js';
import {
  defaultWorkflowAnswers,
  defaultWorkflowSelectedIndex,
  resolveWorkflowAccept,
  toggleStringValue,
  validateWorkflowQuestion,
  workflowQuestionToInputFlowScreen,
} from './workflow-input-flow.js';

const textQuestion: WorkflowQuestionSpecDto = { kind: 'text', key: 'name', label: 'Name' };
const selectQuestion: WorkflowQuestionSpecDto = {
  kind: 'select',
  key: 'env',
  label: 'Environment',
  options: [
    { value: 'dev', label: 'Dev' },
    { value: 'prod', label: 'Prod' },
  ],
};
const multiQuestion: WorkflowQuestionSpecDto = {
  kind: 'multi-select',
  key: 'tags',
  label: 'Tags',
  options: [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ],
};
const confirmQuestion: WorkflowQuestionSpecDto = { kind: 'confirm', key: 'agree', label: 'Agree' };

test('defaultWorkflowAnswers seeds only questions that declare a default', () => {
  const defaultedSelect: WorkflowQuestionSpecDto = {
    kind: 'select',
    key: 'env',
    label: 'Environment',
    options: [{ value: 'prod', label: 'Prod' }],
    default: 'prod',
  };
  const defaultedMulti: WorkflowQuestionSpecDto = {
    kind: 'multi-select',
    key: 'tags',
    label: 'Tags',
    options: [{ value: 'a', label: 'A' }],
    default: ['a'],
  };
  const answers = defaultWorkflowAnswers([textQuestion, defaultedSelect, defaultedMulti]);
  assert.deepEqual(answers, { env: 'prod', tags: ['a'] });
});

test('defaultWorkflowSelectedIndex highlights the committed select value', () => {
  assert.equal(defaultWorkflowSelectedIndex(selectQuestion, 'prod'), 1);
  assert.equal(defaultWorkflowSelectedIndex(selectQuestion, undefined), 0);
  assert.equal(defaultWorkflowSelectedIndex(multiQuestion, ['b']), 0);
  assert.equal(defaultWorkflowSelectedIndex(confirmQuestion, undefined), 0);
  assert.equal(defaultWorkflowSelectedIndex(textQuestion, ''), null);
});

test('validateWorkflowQuestion enforces required answers per kind', () => {
  assert.equal(validateWorkflowQuestion(textQuestion, 'set'), null);
  assert.equal(validateWorkflowQuestion(textQuestion, '   '), paletteCopy.flow.requiredField);
  assert.equal(validateWorkflowQuestion(multiQuestion, ['a']), null);
  assert.equal(validateWorkflowQuestion(multiQuestion, []), paletteCopy.flow.requiredField);
  assert.equal(validateWorkflowQuestion(confirmQuestion, true), null);
  assert.equal(validateWorkflowQuestion(confirmQuestion, false), paletteCopy.flow.requiredConfirm);
});

test('validateWorkflowQuestion treats a declared default as already valid', () => {
  const defaultedText: WorkflowQuestionSpecDto = {
    kind: 'text',
    key: 'name',
    label: 'Name',
    default: 'x',
  };
  assert.equal(validateWorkflowQuestion(defaultedText, ''), null);
});

test('resolveWorkflowAccept auto-picks the highlighted select option', () => {
  assert.deepEqual(resolveWorkflowAccept(selectQuestion, undefined, 1), {
    kind: 'pick',
    value: 'prod',
  });
});

test('resolveWorkflowAccept advances once a select value is committed', () => {
  assert.deepEqual(resolveWorkflowAccept(selectQuestion, 'dev', 1), { kind: 'advance' });
});

test('resolveWorkflowAccept reports validation errors instead of advancing', () => {
  assert.deepEqual(resolveWorkflowAccept(multiQuestion, [], 0), {
    kind: 'error',
    message: paletteCopy.flow.requiredField,
  });
});

test('resolveWorkflowAccept advances a satisfied multi-select', () => {
  assert.deepEqual(resolveWorkflowAccept(multiQuestion, ['a'], 0), { kind: 'advance' });
});

test('toggleStringValue adds and removes values', () => {
  assert.deepEqual(toggleStringValue(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleStringValue(['a', 'b'], 'a'), ['b']);
});

test('workflowQuestionToInputFlowScreen reflects multi-select state', () => {
  const screen = workflowQuestionToInputFlowScreen({
    question: multiQuestion,
    value: ['b'],
    selectedIndex: 1,
    error: null,
  });
  assert.equal(screen.kind, 'multi-select');
  if (screen.kind === 'multi-select') {
    assert.deepEqual(screen.selectedValues, ['b']);
    assert.equal(screen.selectedIndex, 1);
    assert.equal(screen.options.length, 2);
  }
});
