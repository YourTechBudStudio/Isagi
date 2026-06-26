import { useEffect, useMemo, useRef, useState } from 'react';

import type { WorkflowQuestionSpecDto } from '@isagi/contracts';

import { InputFlowScreenView } from '../../components/input-flow/index.js';
import { useKeyboardSelection } from '../../hooks/useKeyboardSelection.js';
import {
  asStringArray,
  defaultWorkflowAnswers,
  defaultWorkflowSelectedIndex,
  resolveWorkflowAccept,
  toggleStringValue,
  workflowQuestionToInputFlowScreen,
  workflowSelectableLength,
  type WorkflowInputAnswers,
} from '../../lib/palette/workflow-input-flow.js';

export type { WorkflowInputAnswers };

export function WorkflowInputFlow({
  questions,
  disabled = false,
  autoFocus = false,
  onSubmit,
  onBack,
}: {
  readonly questions: readonly WorkflowQuestionSpecDto[];
  readonly disabled?: boolean | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly onSubmit: (answers: WorkflowInputAnswers) => void;
  readonly onBack?: (() => void) | undefined;
}) {
  const defaults = useMemo(() => defaultWorkflowAnswers(questions), [questions]);
  const [answers, setAnswers] = useState<WorkflowInputAnswers>(defaults);
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const question = questions[stepIndex];
  const value = question ? answers[question.key] : undefined;

  useEffect(() => {
    setAnswers(defaults);
    setStepIndex(0);
    setError(null);
  }, [defaults]);

  const updateAnswer = (key: string, next: unknown) => {
    setAnswers((current) => ({ ...current, [key]: next }));
    setError(null);
  };

  const finishOrAdvance = (nextAnswers: WorkflowInputAnswers) => {
    if (stepIndex >= questions.length - 1) {
      onSubmit(nextAnswers);
      return;
    }
    setStepIndex((current) => current + 1);
    setError(null);
  };

  // Handlers run on user events (after render), so they read the live highlight
  // from a ref rather than closing over a stale value — and the hook can be
  // wired before `selectedIndex` exists.
  const selectedIndexRef = useRef<number | null>(null);

  const accept = () => {
    if (!question) {
      onSubmit(answers);
      return;
    }
    const result = resolveWorkflowAccept(question, value, selectedIndexRef.current);
    if (result.kind === 'error') {
      setError(result.message);
      return;
    }
    if (result.kind === 'pick') {
      const nextAnswers = { ...answers, [question.key]: result.value };
      setAnswers(nextAnswers);
      setError(null);
      finishOrAdvance(nextAnswers);
      return;
    }
    finishOrAdvance(answers);
  };

  const pick = (index: number) => {
    if (!question) return;
    if (question.kind !== 'select' && question.kind !== 'multi-select') return;
    const option = question.options[index];
    if (!option) return;

    if (question.kind === 'multi-select') {
      updateAnswer(question.key, toggleStringValue(asStringArray(value), option.value));
      return;
    }

    const nextAnswers = { ...answers, [question.key]: option.value };
    setAnswers(nextAnswers);
    setError(null);
    finishOrAdvance(nextAnswers);
  };

  const toggleConfirm = () => {
    if (!question || question.kind !== 'confirm') return;
    updateAnswer(question.key, value !== true);
  };

  const back = () => {
    if (stepIndex === 0) {
      onBack?.();
      return;
    }
    setStepIndex((current) => current - 1);
    setError(null);
  };

  // A confirm sitting at `false` accepts by flipping to `true`; everything else
  // accepts by validating/advancing. Computed from the question + value so the
  // hook can be wired without the rendered screen.
  const isUnconfirmedConfirm = question?.kind === 'confirm' && value !== true;

  const selection = useKeyboardSelection({
    length: question ? workflowSelectableLength(question) : 0,
    snapKey: String(stepIndex),
    defaultIndex: question ? defaultWorkflowSelectedIndex(question, value) : null,
    capabilities: {
      back: onBack !== undefined,
      // Space toggles the highlighted option for multi-select (the only kind
      // where Enter advances rather than selects).
      toggle: question?.kind === 'multi-select',
    },
    handlers: {
      onAccept: isUnconfirmedConfirm ? toggleConfirm : accept,
      onBack: onBack ? back : undefined,
      onToggleHighlighted: () => {
        const index = selectedIndexRef.current;
        if (index !== null) pick(index);
      },
    },
  });
  selectedIndexRef.current = selection.selectedIndex;

  const screen = question
    ? workflowQuestionToInputFlowScreen({
        question,
        value,
        selectedIndex: selection.selectedIndex,
        error,
      })
    : null;

  if (!screen) {
    return null;
  }

  return (
    <InputFlowScreenView
      screen={screen}
      disabled={disabled}
      autoFocus={autoFocus}
      onKeyDown={selection.onKeyDown}
      onQueryChange={(query) => {
        if (question?.kind === 'text') {
          updateAnswer(question.key, query);
        }
      }}
      onPick={pick}
      onToggle={toggleConfirm}
      onAccept={accept}
    />
  );
}
