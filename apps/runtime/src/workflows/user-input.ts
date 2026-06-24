import { Data } from 'effect';

import type { WorkflowQuestionSpec } from './types.js';

export type WorkflowUserInputAnswers = Record<string, string | string[] | boolean>;

export type WorkflowUserInputValidationReason =
  | 'invalid_wait_condition'
  | 'duplicate_question_key'
  | 'unknown_answer_key'
  | 'missing_required_answer'
  | 'invalid_answer_type'
  | 'invalid_answer_value'
  | 'invalid_question_options'
  | 'invalid_question_default';

export class WorkflowUserInputValidationError extends Data.TaggedError(
  'WorkflowUserInputValidationError',
)<{
  readonly reason: WorkflowUserInputValidationReason;
  readonly message: string;
  readonly questionKey?: string | undefined;
  readonly answerKey?: string | undefined;
}> {}

export function validateWorkflowUserInputAnswers(input: {
  readonly questions: readonly WorkflowQuestionSpec[];
  readonly answers: Record<string, unknown>;
}): WorkflowUserInputAnswers {
  const answers = input.answers;
  const result: WorkflowUserInputAnswers = {};
  const questionKeys = new Set<string>();

  for (const question of input.questions) {
    if (questionKeys.has(question.key)) {
      throw new WorkflowUserInputValidationError({
        reason: 'duplicate_question_key',
        message: `Workflow user input question '${question.key}' is duplicated.`,
        questionKey: question.key,
      });
    }
    questionKeys.add(question.key);
  }

  for (const answerKey of Object.keys(answers)) {
    if (!questionKeys.has(answerKey)) {
      throw new WorkflowUserInputValidationError({
        reason: 'unknown_answer_key',
        message: `Workflow user input answer '${answerKey}' was not requested.`,
        answerKey,
      });
    }
  }

  for (const question of input.questions) {
    if (!(question.key in answers)) {
      const defaultValue = defaultForQuestion(question);
      if (defaultValue !== undefined) {
        result[question.key] = defaultValue;
        continue;
      }
      throw new WorkflowUserInputValidationError({
        reason: 'missing_required_answer',
        message: `Workflow user input answer '${question.key}' is required.`,
        questionKey: question.key,
      });
    }

    result[question.key] = validateAnswer(question, answers[question.key]);
  }

  return result;
}

function validateAnswer(question: WorkflowQuestionSpec, answer: unknown) {
  if (question.kind === 'text') {
    if (typeof answer !== 'string') {
      throw invalidType(question, 'string');
    }
    return answer;
  }

  if (question.kind === 'confirm') {
    if (typeof answer !== 'boolean') {
      throw invalidType(question, 'boolean');
    }
    return answer;
  }

  if (question.kind === 'select') {
    if (typeof answer !== 'string') {
      throw invalidType(question, 'string');
    }
    assertOptions(question);
    if (!optionValues(question).has(answer)) {
      throw invalidValue(question, answer);
    }
    return answer;
  }

  if (!Array.isArray(answer) || !answer.every((value) => typeof value === 'string')) {
    throw invalidType(question, 'string[]');
  }
  assertOptions(question);
  const values = optionValues(question);
  const invalid = answer.find((value) => !values.has(value));
  if (invalid !== undefined) {
    throw invalidValue(question, invalid);
  }
  return [...answer];
}

function defaultForQuestion(question: WorkflowQuestionSpec) {
  if (!('default' in question) || question.default === undefined) return undefined;
  const defaultValue = question.default;

  if (question.kind === 'text') {
    if (typeof defaultValue !== 'string') throw invalidDefault(question);
    return defaultValue;
  }

  if (question.kind === 'confirm') {
    if (typeof defaultValue !== 'boolean') throw invalidDefault(question);
    return defaultValue;
  }

  if (question.kind === 'select') {
    if (typeof defaultValue !== 'string') throw invalidDefault(question);
    assertOptions(question);
    if (!optionValues(question).has(defaultValue)) throw invalidDefault(question);
    return defaultValue;
  }

  if (!Array.isArray(defaultValue) || !defaultValue.every((value) => typeof value === 'string')) {
    throw invalidDefault(question);
  }
  assertOptions(question);
  const values = optionValues(question);
  if (defaultValue.some((value) => !values.has(value))) throw invalidDefault(question);
  return [...defaultValue];
}

function assertOptions(
  question: Extract<WorkflowQuestionSpec, { readonly kind: 'select' | 'multi-select' }>,
) {
  if (question.options.length === 0) {
    throw new WorkflowUserInputValidationError({
      reason: 'invalid_question_options',
      message: `Workflow user input question '${question.key}' has no options.`,
      questionKey: question.key,
    });
  }
}

function optionValues(
  question: Extract<WorkflowQuestionSpec, { readonly kind: 'select' | 'multi-select' }>,
) {
  return new Set(question.options.map((option) => option.value));
}

function invalidType(question: WorkflowQuestionSpec, expected: string) {
  return new WorkflowUserInputValidationError({
    reason: 'invalid_answer_type',
    message: `Workflow user input answer '${question.key}' must be ${expected}.`,
    questionKey: question.key,
  });
}

function invalidValue(question: WorkflowQuestionSpec, value: string) {
  return new WorkflowUserInputValidationError({
    reason: 'invalid_answer_value',
    message: `Workflow user input answer '${question.key}' has invalid value '${value}'.`,
    questionKey: question.key,
  });
}

function invalidDefault(question: WorkflowQuestionSpec) {
  return new WorkflowUserInputValidationError({
    reason: 'invalid_question_default',
    message: `Workflow user input question '${question.key}' has an invalid default.`,
    questionKey: question.key,
  });
}
