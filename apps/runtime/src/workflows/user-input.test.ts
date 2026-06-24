import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowQuestionSpec } from './types.js';
import {
  validateWorkflowUserInputAnswers,
  WorkflowUserInputValidationError,
} from './user-input.js';

const questions: readonly WorkflowQuestionSpec[] = [
  { kind: 'text', key: 'summary', label: 'Summary' },
  {
    kind: 'select',
    key: 'risk',
    label: 'Risk',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
    default: 'low',
  },
  {
    kind: 'multi-select',
    key: 'areas',
    label: 'Areas',
    options: [{ value: 'runtime' }, { value: 'web' }],
    default: ['runtime'],
  },
  { kind: 'confirm', key: 'approved', label: 'Approved', default: false },
];

test('validateWorkflowUserInputAnswers applies defaults and preserves explicit answers', () => {
  assert.deepEqual(
    validateWorkflowUserInputAnswers({
      questions,
      answers: { summary: 'Looks good', areas: ['runtime', 'web'] },
    }),
    {
      summary: 'Looks good',
      risk: 'low',
      areas: ['runtime', 'web'],
      approved: false,
    },
  );
});

test('validateWorkflowUserInputAnswers rejects unknown answers', () => {
  assertValidationReason(
    () =>
      validateWorkflowUserInputAnswers({
        questions,
        answers: { summary: 'ok', extra: true },
      }),
    'unknown_answer_key',
  );
});

test('validateWorkflowUserInputAnswers rejects missing required answers', () => {
  assertValidationReason(
    () => validateWorkflowUserInputAnswers({ questions, answers: {} }),
    'missing_required_answer',
  );
});

test('validateWorkflowUserInputAnswers rejects wrong primitive types', () => {
  assertValidationReason(
    () =>
      validateWorkflowUserInputAnswers({
        questions,
        answers: { summary: 'ok', approved: 'yes' },
      }),
    'invalid_answer_type',
  );
});

test('validateWorkflowUserInputAnswers rejects select values outside persisted options', () => {
  assertValidationReason(
    () =>
      validateWorkflowUserInputAnswers({
        questions,
        answers: { summary: 'ok', risk: 'medium' },
      }),
    'invalid_answer_value',
  );
});

test('validateWorkflowUserInputAnswers rejects multi-select values outside persisted options', () => {
  assertValidationReason(
    () =>
      validateWorkflowUserInputAnswers({
        questions,
        answers: { summary: 'ok', areas: ['runtime', 'mobile'] },
      }),
    'invalid_answer_value',
  );
});

test('validateWorkflowUserInputAnswers rejects duplicate question keys', () => {
  assertValidationReason(
    () =>
      validateWorkflowUserInputAnswers({
        questions: [
          { kind: 'text', key: 'summary', label: 'Summary' },
          { kind: 'confirm', key: 'summary', label: 'Same key' },
        ],
        answers: { summary: 'ok' },
      }),
    'duplicate_question_key',
  );
});

function assertValidationReason(
  run: () => unknown,
  reason: WorkflowUserInputValidationError['reason'],
) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof WorkflowUserInputValidationError);
    assert.equal(error.reason, reason);
    return true;
  });
}
