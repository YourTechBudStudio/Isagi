import type { WorkflowQuestionSpecDto } from '@isagi/contracts';

import type { InputFlowOption, InputFlowScreen } from '../../components/input-flow/index.js';
import { paletteCopy } from '../../copy/index.js';

export type WorkflowInputAnswers = Record<string, unknown>;

/**
 * Seed answers from each question's declared default. Questions without a
 * default are left unset so validation can require them.
 */
export function defaultWorkflowAnswers(
  questions: readonly WorkflowQuestionSpecDto[],
): WorkflowInputAnswers {
  return Object.fromEntries(
    questions.flatMap((question) =>
      'default' in question && question.default !== undefined
        ? [[question.key, question.default]]
        : [],
    ),
  );
}

/** Map a workflow question + its current answer into a presentational screen. */
export function workflowQuestionToInputFlowScreen({
  question,
  value,
  selectedIndex,
  error,
}: {
  readonly question: WorkflowQuestionSpecDto;
  readonly value: unknown;
  readonly selectedIndex: number | null;
  readonly error: string | null;
}): InputFlowScreen {
  switch (question.kind) {
    case 'text':
      return {
        kind: 'text',
        label: question.label,
        value: typeof value === 'string' ? value : '',
        placeholder: question.placeholder,
        error,
      };
    case 'select':
      return {
        kind: 'select',
        label: question.label,
        options: question.options as readonly InputFlowOption[],
        selectedIndex,
        error,
      };
    case 'multi-select':
      return {
        kind: 'multi-select',
        label: question.label,
        options: question.options as readonly InputFlowOption[],
        selectedValues: asStringArray(value),
        selectedIndex,
        hint: paletteCopy.flow.multiSelectHint,
        error,
      };
    case 'confirm':
      return {
        kind: 'confirm',
        label: question.label,
        value: value === true,
        selectedIndex,
        error,
      };
  }
}

/**
 * Number of keyboard-selectable rows for a question. Derived from the question
 * (not its rendered screen) so selection can be wired before the screen — which
 * carries the highlight index — is built.
 */
export function workflowSelectableLength(question: WorkflowQuestionSpecDto): number {
  switch (question.kind) {
    case 'select':
    case 'multi-select':
      return question.options.length;
    case 'confirm':
      return 1;
    case 'text':
      return 0;
  }
}

/** Where the keyboard highlight lands when a question first becomes active. */
export function defaultWorkflowSelectedIndex(
  question: WorkflowQuestionSpecDto,
  value: unknown,
): number | null {
  if (question.kind === 'select') {
    const valueIndex =
      typeof value === 'string'
        ? question.options.findIndex((option) => option.value === value)
        : -1;
    if (valueIndex >= 0) return valueIndex;
    return question.options.length > 0 ? 0 : null;
  }
  if (question.kind === 'multi-select') {
    return question.options.length > 0 ? 0 : null;
  }
  if (question.kind === 'confirm') {
    return 0;
  }
  return null;
}

/** Validate a single answer; returns an error message or `null` when valid. */
export function validateWorkflowQuestion(
  question: WorkflowQuestionSpecDto,
  value: unknown,
): string | null {
  if ('default' in question && question.default !== undefined) return null;
  if (question.kind === 'confirm') {
    return value === true ? null : paletteCopy.flow.requiredConfirm;
  }
  if (question.kind === 'multi-select') {
    return asStringArray(value).length > 0 ? null : paletteCopy.flow.requiredField;
  }
  return typeof value === 'string' && value.trim().length > 0
    ? null
    : paletteCopy.flow.requiredField;
}

export type WorkflowAcceptResult =
  // A single-select with no committed value yet: commit the highlighted option.
  | { readonly kind: 'pick'; readonly value: string }
  // The current answer is valid: advance (or submit on the last step).
  | { readonly kind: 'advance' }
  // The current answer is missing/invalid: surface the message, stay put.
  | { readonly kind: 'error'; readonly message: string };

/**
 * Decide what pressing Enter does for the active question. Kept pure so the
 * select auto-pick and validation rules are unit-testable independently of the
 * component's local state.
 */
export function resolveWorkflowAccept(
  question: WorkflowQuestionSpecDto,
  value: unknown,
  selectedIndex: number | null,
): WorkflowAcceptResult {
  if (question.kind === 'select') {
    const option = selectedIndex === null ? undefined : question.options[selectedIndex];
    if (option && option.value !== value) {
      return { kind: 'pick', value: option.value };
    }
  }
  const message = validateWorkflowQuestion(question, value);
  return message ? { kind: 'error', message } : { kind: 'advance' };
}

/** Toggle a value in a string set (used by multi-select questions). */
export function toggleStringValue(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
