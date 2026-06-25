import { useMemo, useState, type ReactNode } from 'react';

import type { WorkflowQuestionOptionDto, WorkflowQuestionSpecDto } from '@isagi/contracts';

import { workflowCopy } from '../../copy/index.js';

export type WorkflowQuestionAnswers = Record<string, unknown>;

export function WorkflowQuestionForm({
  questions,
  submitLabel = workflowCopy.submitPrompt,
  onSubmit,
  disabled = false,
}: {
  readonly questions: readonly WorkflowQuestionSpecDto[];
  readonly submitLabel?: string | undefined;
  readonly onSubmit: (answers: WorkflowQuestionAnswers) => void;
  readonly disabled?: boolean | undefined;
}) {
  const initialAnswers = useMemo(() => defaultAnswers(questions), [questions]);
  const [answers, setAnswers] = useState<WorkflowQuestionAnswers>(initialAnswers);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const update = (key: string, value: unknown) => {
    setAnswers((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const submit = () => {
    const nextErrors = validateAnswers(questions, answers);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    onSubmit(answers);
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {questions.map((question) => (
        <WorkflowQuestionField
          key={question.key}
          question={question}
          value={answers[question.key]}
          error={errors[question.key]}
          disabled={disabled}
          onChange={(value) => update(question.key, value)}
        />
      ))}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={disabled}
          className="rounded-md bg-blue/16 px-3 py-1.5 font-mono text-[11.5px] text-blue transition duration-micro ease-expo hover:bg-blue/22 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function WorkflowQuestionField({
  question,
  value,
  error,
  disabled,
  onChange,
}: {
  readonly question: WorkflowQuestionSpecDto;
  readonly value: unknown;
  readonly error?: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: unknown) => void;
}) {
  switch (question.kind) {
    case 'text':
      return (
        <FieldFrame label={question.label} error={error}>
          <input
            type="text"
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            placeholder={question.placeholder}
            className="h-8 w-full rounded-md border border-line/30 bg-canvas/40 px-2.5 font-mono text-[12px] text-fg transition duration-micro ease-expo placeholder:text-fg-subtle focus:border-blue/45 focus:outline-none disabled:cursor-not-allowed disabled:opacity-55"
          />
        </FieldFrame>
      );
    case 'select':
      return (
        <FieldFrame label={question.label} error={error}>
          <OptionRows
            options={question.options}
            value={typeof value === 'string' ? value : undefined}
            disabled={disabled}
            onPick={(next) => onChange(next)}
          />
        </FieldFrame>
      );
    case 'multi-select':
      return (
        <FieldFrame label={question.label} error={error}>
          <OptionRows
            options={question.options}
            value={Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []}
            disabled={disabled}
            onPick={(next) => {
              const current = Array.isArray(value)
                ? value.filter((item): item is string => typeof item === 'string')
                : [];
              onChange(
                current.includes(next)
                  ? current.filter((item) => item !== next)
                  : [...current, next],
              );
            }}
            multiple
          />
        </FieldFrame>
      );
    case 'confirm':
      return (
        <FieldFrame label={question.label} error={error}>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={value === true}
            onClick={() => onChange(value !== true)}
            className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left transition duration-micro ease-expo disabled:cursor-not-allowed disabled:opacity-55 ${
              value === true ? 'bg-white/8' : 'hover:bg-white/4'
            }`}
          >
            <span className="w-4 text-center font-mono text-[12px] text-fg-subtle">
              {value === true ? '●' : '○'}
            </span>
            <span className="text-[13px] text-fg">{question.label}</span>
          </button>
        </FieldFrame>
      );
  }
}

function FieldFrame({
  label,
  error,
  children,
}: {
  readonly label: string;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 font-mono text-[11.5px] text-fg-muted">{label}</p>
      {children}
      {error && <p className="mt-1.5 font-mono text-[10.5px] text-amber">{error}</p>}
    </div>
  );
}

function OptionRows({
  options,
  value,
  multiple = false,
  disabled,
  onPick,
}: {
  readonly options: readonly WorkflowQuestionOptionDto[];
  readonly value: string | readonly string[] | undefined;
  readonly multiple?: boolean | undefined;
  readonly disabled: boolean;
  readonly onPick: (value: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-line/20 bg-white/4">
      {options.map((option) => {
        const selected = Array.isArray(value)
          ? value.includes(option.value)
          : value === option.value;
        return (
          <button
            type="button"
            key={option.value}
            disabled={disabled}
            onClick={() => onPick(option.value)}
            className={`flex w-full items-center gap-3 px-3 py-2.25 text-left transition duration-micro ease-expo disabled:cursor-not-allowed disabled:opacity-55 ${
              selected ? 'bg-white/8' : 'hover:bg-white/4'
            }`}
          >
            <span className="w-4 text-center font-mono text-[12px] text-fg-subtle">
              {selected ? '●' : '○'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-fg">
                {option.label ?? option.value}
              </span>
              {option.hint && (
                <span className="block truncate font-mono text-[10.5px] text-fg-subtle">
                  {option.hint}
                </span>
              )}
            </span>
            {multiple && selected && <span className="font-mono text-[10.5px] text-cyan">set</span>}
          </button>
        );
      })}
    </div>
  );
}

function defaultAnswers(questions: readonly WorkflowQuestionSpecDto[]): WorkflowQuestionAnswers {
  return Object.fromEntries(
    questions.flatMap((question) =>
      'default' in question && question.default !== undefined
        ? [[question.key, question.default]]
        : [],
    ),
  );
}

function validateAnswers(
  questions: readonly WorkflowQuestionSpecDto[],
  answers: WorkflowQuestionAnswers,
): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const question of questions) {
    if ('default' in question && question.default !== undefined) continue;
    const value = answers[question.key];
    if (question.kind === 'confirm') {
      if (value !== true) errors[question.key] = workflowCopy.requiredConfirm;
      continue;
    }
    if (question.kind === 'multi-select') {
      if (!Array.isArray(value) || value.length === 0) {
        errors[question.key] = workflowCopy.requiredField;
      }
      continue;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors[question.key] = workflowCopy.requiredField;
    }
  }
  return errors;
}
