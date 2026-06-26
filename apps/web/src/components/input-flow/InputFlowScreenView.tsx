import { Plus } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { paletteCopy } from '../../copy/index.js';
import {
  inputFlowHasTextInput,
  inputFlowQueryControl,
  type InputFlowOption,
  type InputFlowReviewChoice,
  type InputFlowScreen,
} from './types.js';

export interface InputFlowScreenViewProps {
  readonly screen: InputFlowScreen;
  readonly disabled?: boolean | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly onQueryChange?: ((query: string) => void) | undefined;
  readonly onKeyDown?: ((event: ReactKeyboardEvent) => void) | undefined;
  readonly onPick?: ((index: number) => void) | undefined;
  readonly onToggle?: (() => void) | undefined;
  readonly onAccept: () => void;
}

export interface InputFlowControlProps {
  readonly screen: InputFlowScreen;
  readonly disabled?: boolean | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly inputClassName?: string | undefined;
  readonly labelClassName?: string | undefined;
  readonly onQueryChange?: ((query: string) => void) | undefined;
}

export interface InputFlowBodyProps {
  readonly screen: InputFlowScreen;
  readonly disabled?: boolean | undefined;
  readonly onPick?: ((index: number) => void) | undefined;
  readonly onToggle?: (() => void) | undefined;
  readonly onAccept: () => void;
}

export function InputFlowScreenView({
  screen,
  disabled = false,
  autoFocus = false,
  onQueryChange,
  onKeyDown,
  onPick,
  onToggle,
  onAccept,
}: InputFlowScreenViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Screens with a text input let InputFlowControl own focus; only capture it on
  // the root for option/confirm/review screens that rely on root-level keys.
  // (Child effects run before parent ones, so focusing the root unconditionally
  // would steal focus from a just-focused input on mount.)
  const hasInputControl = inputFlowHasTextInput(screen);

  useEffect(() => {
    if (!autoFocus || hasInputControl) return;
    rootRef.current?.focus();
  }, [autoFocus, hasInputControl]);

  return (
    <div ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} className="outline-none">
      <div className="border-b border-line/16 px-3 py-2">
        <InputFlowControl
          screen={screen}
          disabled={disabled}
          autoFocus={autoFocus}
          inputClassName="h-8 w-full rounded-md border border-line/30 bg-canvas/40 px-2.5 font-mono text-[12px] text-fg transition duration-micro ease-expo placeholder:text-fg-subtle focus:border-blue/45 focus:outline-none disabled:cursor-not-allowed disabled:opacity-55"
          labelClassName="font-mono text-[11.5px] text-fg-muted"
          onQueryChange={onQueryChange}
        />
      </div>
      <InputFlowBody
        screen={screen}
        disabled={disabled}
        onPick={onPick}
        onToggle={onToggle}
        onAccept={onAccept}
      />
    </div>
  );
}

export function InputFlowControl({
  screen,
  disabled = false,
  autoFocus = false,
  inputClassName = 'min-w-30 flex-1 bg-transparent font-sans text-[15px] text-fg outline-none placeholder:text-fg-subtle',
  labelClassName = 'min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-subtle',
  onQueryChange,
}: InputFlowControlProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const queryControl = inputFlowQueryControl(screen);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus, queryControl?.kind]);

  if (queryControl) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={queryControl.value}
        disabled={disabled}
        onChange={(event) => onQueryChange?.(event.target.value)}
        placeholder={queryControl.placeholder}
        className={inputClassName}
      />
    );
  }

  return <span className={labelClassName}>{inputFlowControlLabel(screen)}</span>;
}

export function InputFlowBody({
  screen,
  disabled = false,
  onPick,
  onToggle,
  onAccept,
}: InputFlowBodyProps) {
  if (screen.kind === 'text') {
    return <TextBody screen={screen} />;
  }
  if (screen.kind === 'select' || screen.kind === 'combo') {
    return <OptionBody screen={screen} disabled={disabled} onPick={onPick} />;
  }
  if (screen.kind === 'multi-select') {
    return (
      <MultiSelectScreen
        label={screen.label}
        options={screen.options}
        selectedValues={screen.selectedValues}
        selectedIndex={screen.selectedIndex}
        hint={screen.hint}
        error={screen.error}
        disabled={disabled}
        onAccept={onAccept}
        onPick={onPick}
      />
    );
  }
  if (screen.kind === 'confirm') {
    return <ConfirmScreen screen={screen} disabled={disabled} onToggle={onToggle} />;
  }
  if (screen.kind === 'path') {
    return <PathBody screen={screen} disabled={disabled} onPick={onPick} />;
  }
  return <ReviewScreen screen={screen} disabled={disabled} onPick={onPick} />;
}

function TextBody({ screen }: { readonly screen: Extract<InputFlowScreen, { kind: 'text' }> }) {
  return (
    <div className="px-3 py-4">
      <FieldLabel label={screen.label} error={screen.error} />
      <p className="font-mono text-[11px] text-fg-subtle">
        {screen.hint ??
          (screen.value ? paletteCopy.textStep.useValue : paletteCopy.textStep.typeThenUse)}
      </p>
      {screen.value && (
        <p className="mt-2 rounded-sm border border-line/22 bg-white/6 px-3 py-2 font-mono text-[13px] text-fg">
          {screen.value}
        </p>
      )}
    </div>
  );
}

function OptionBody({
  screen,
  disabled,
  onPick,
}: {
  readonly screen: Extract<InputFlowScreen, { kind: 'select' | 'combo' }>;
  readonly disabled: boolean;
  readonly onPick?: ((index: number) => void) | undefined;
}) {
  if (screen.error) {
    return <p className="px-3 py-4 font-mono text-[12px] text-error">{screen.error}</p>;
  }

  return (
    <div>
      {screen.hint && (
        <p className="px-3 py-2 font-mono text-[11px] text-fg-subtle">{screen.hint}</p>
      )}
      {screen.loading && (
        <p className="px-3 py-4 font-mono text-[12px] text-fg-subtle">
          {paletteCopy.wizardStep.loading}
        </p>
      )}
      <OptionRows
        options={screen.options}
        selectedIndex={screen.selectedIndex}
        disabled={disabled}
        onPick={onPick}
      />
    </div>
  );
}

function MultiSelectScreen({
  label,
  options,
  selectedValues,
  selectedIndex,
  hint,
  error,
  disabled,
  onAccept,
  onPick,
}: {
  readonly label: string;
  readonly options: readonly InputFlowOption[];
  readonly selectedValues: readonly string[];
  readonly selectedIndex: number | null;
  readonly hint?: string | undefined;
  readonly error?: string | null | undefined;
  readonly disabled: boolean;
  readonly onAccept: () => void;
  readonly onPick?: ((index: number) => void) | undefined;
}) {
  if (error) {
    return <p className="px-3 py-4 font-mono text-[12px] text-error">{error}</p>;
  }

  return (
    <div>
      <div className="px-3 py-2">
        <FieldLabel label={label} />
        {hint && <p className="font-mono text-[11px] text-fg-subtle">{hint}</p>}
      </div>
      <OptionRows
        options={options}
        selectedIndex={selectedIndex}
        selectedValues={selectedValues}
        disabled={disabled}
        multiple
        onPick={onPick}
      />
      <div className="flex justify-end px-3 py-3">
        <button
          type="button"
          disabled={disabled}
          onClick={onAccept}
          className="rounded-md bg-blue/16 px-3 py-1.5 font-mono text-[11.5px] text-blue transition duration-micro ease-expo hover:bg-blue/22 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {paletteCopy.flow.continue}
        </button>
      </div>
    </div>
  );
}

function ConfirmScreen({
  screen,
  disabled,
  onToggle,
}: {
  readonly screen: Extract<InputFlowScreen, { kind: 'confirm' }>;
  readonly disabled: boolean;
  readonly onToggle?: (() => void) | undefined;
}) {
  return (
    <div className="px-3 py-3">
      <FieldLabel label={screen.label} error={screen.error} />
      <button
        type="button"
        disabled={disabled}
        aria-pressed={screen.value}
        onClick={onToggle}
        className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left transition duration-micro ease-expo disabled:cursor-not-allowed disabled:opacity-55 ${
          screen.value ? 'bg-white/8' : 'hover:bg-white/4'
        }`}
      >
        <span className="w-4 text-center font-mono text-[12px] text-fg-subtle">
          {screen.value ? '●' : '○'}
        </span>
        <span className="text-[13px] text-fg">{screen.label}</span>
      </button>
    </div>
  );
}

function PathBody({
  screen,
  disabled,
  onPick,
}: {
  readonly screen: Extract<InputFlowScreen, { kind: 'path' }>;
  readonly disabled: boolean;
  readonly onPick?: ((index: number) => void) | undefined;
}) {
  if (screen.error) {
    return (
      <p className="wrap-break-word px-3 py-4 font-mono text-[12px] text-error">{screen.error}</p>
    );
  }

  return (
    <div aria-busy={screen.loading}>
      <div className="px-3 py-2">
        <FieldLabel label={screen.label} />
        <p className="font-mono text-[11px] text-fg-subtle">
          {screen.loading
            ? paletteCopy.pathStep.searching
            : screen.value
              ? paletteCopy.pathStep.addPath
              : paletteCopy.pathStep.typeRepositoryRoot}
        </p>
      </div>
      {screen.suggestions.map((suggestion, index) => (
        <button
          type="button"
          key={suggestion.path}
          disabled={disabled || screen.stale}
          onClick={() => onPick?.(index)}
          className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left transition duration-micro ease-expo disabled:cursor-not-allowed ${
            screen.stale
              ? 'opacity-55'
              : index === screen.selectedIndex
                ? 'bg-white/8'
                : 'hover:bg-white/4'
          }`}
        >
          <span className="w-4 text-center font-mono text-[12px] text-fg-subtle">
            {!screen.stale && index === screen.selectedIndex ? '●' : '○'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] text-fg">{suggestion.label}</span>
            <span className="block truncate font-mono text-[10.5px] text-fg-subtle">
              {suggestion.path}
            </span>
          </span>
          {suggestion.hidden && (
            <span className="font-mono text-[10.5px] text-fg-subtle">hidden</span>
          )}
        </button>
      ))}
    </div>
  );
}

function ReviewScreen({
  screen,
  disabled,
  onPick,
}: {
  readonly screen: Extract<InputFlowScreen, { kind: 'review' }>;
  readonly disabled: boolean;
  readonly onPick?: ((index: number) => void) | undefined;
}) {
  if (screen.error) {
    return <p className="px-3 py-4 font-mono text-[12px] text-error">{screen.error}</p>;
  }
  if (screen.loading || !screen.content) {
    return (
      <p className="px-3 py-4 font-mono text-[12px] text-fg-subtle">
        {paletteCopy.reviewStep.loading}
      </p>
    );
  }

  return (
    <div className="px-3 py-3">
      <p className="text-[13.5px] font-medium text-fg">{screen.content.title}</p>
      <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">{screen.content.body}</p>
      {screen.content.items.length > 0 && (
        <div className="mt-3 space-y-1.5 rounded-md border border-line/20 bg-white/5 p-2">
          {screen.content.items.map((item, index) => (
            <div key={`${item.label}-${index}`} className="rounded-sm px-2 py-1.5">
              <p className="font-mono text-[11.5px] text-fg">
                {index + 1}. {item.label}
              </p>
              {item.detail && (
                <p className="mt-0.5 font-mono text-[10.5px] text-fg-subtle">{item.detail}</p>
              )}
              {item.envKeys && item.envKeys.length > 0 && (
                <p className="mt-0.5 font-mono text-[10.5px] text-fg-subtle">
                  env: {item.envKeys.join(', ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 space-y-1">
        {screen.content.choices.map((choice, index) => {
          const tone = reviewChoiceTone(choice.intent, index === screen.selectedIndex);
          return (
            <button
              type="button"
              key={choice.value}
              disabled={disabled}
              onClick={() => onPick?.(index)}
              className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left transition duration-micro ease-expo disabled:cursor-not-allowed disabled:opacity-55 ${tone.row}`}
            >
              <span className={`w-4 text-center font-mono text-[12px] ${tone.glyph}`}>
                {index === screen.selectedIndex ? '●' : '○'}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[13.5px] ${tone.label}`}>{choice.label}</span>
                {choice.hint && (
                  <span className="block truncate font-mono text-[10.5px] text-fg-subtle">
                    {choice.hint}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OptionRows({
  options,
  selectedIndex,
  selectedValues = [],
  multiple = false,
  disabled,
  onPick,
}: {
  readonly options: readonly InputFlowOption[];
  readonly selectedIndex: number | null;
  readonly selectedValues?: readonly string[] | undefined;
  readonly multiple?: boolean | undefined;
  readonly disabled: boolean;
  readonly onPick?: ((index: number) => void) | undefined;
}) {
  return (
    <>
      {options.map((option, index) => {
        const selected = multiple ? selectedValues.includes(option.value) : index === selectedIndex;
        return option.create ? (
          <button
            type="button"
            key={option.value}
            disabled={disabled}
            onClick={() => onPick?.(index)}
            className={`mx-1 my-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-md border px-3 py-2.25 text-left transition duration-micro ease-expo disabled:cursor-not-allowed disabled:opacity-55 ${
              index === selectedIndex
                ? 'border-green/45 bg-green/16'
                : 'border-green/30 bg-green/10 hover:bg-green/16'
            }`}
          >
            <Plus size={14} className="shrink-0 text-green" />
            <span className="flex-1 truncate text-[13.5px] font-medium text-green">
              {option.label ?? option.value}
            </span>
            {option.hint && (
              <span className="font-mono text-[10.5px] text-green/70">{option.hint}</span>
            )}
          </button>
        ) : (
          <button
            type="button"
            key={option.value}
            disabled={disabled}
            onClick={() => onPick?.(index)}
            className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left transition duration-micro ease-expo disabled:cursor-not-allowed disabled:opacity-55 ${
              selected || index === selectedIndex ? 'bg-white/8' : 'hover:bg-white/4'
            }`}
          >
            <span className="w-4 text-center font-mono text-[12px] text-fg-subtle">
              {selected || index === selectedIndex ? '●' : '○'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] text-fg">
                {option.label ?? option.value}
              </span>
              {option.hint && (
                <span className="block truncate font-mono text-[10.5px] text-fg-subtle">
                  {option.hint}
                </span>
              )}
            </span>
            {option.isDefault && <span className="font-mono text-[10.5px] text-cyan">default</span>}
            {multiple && selected && <span className="font-mono text-[10.5px] text-cyan">set</span>}
          </button>
        );
      })}
    </>
  );
}

function FieldLabel({
  label,
  error,
}: {
  readonly label: string;
  readonly error?: string | null | undefined;
}) {
  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-2">
      <p className="min-w-0 truncate font-mono text-[11.5px] text-fg-muted">{label}</p>
      {error && <p className="min-w-0 truncate font-mono text-[10.5px] text-error">{error}</p>}
    </div>
  );
}

function reviewChoiceTone(intent: InputFlowReviewChoice['intent'], selected: boolean) {
  if (intent === 'danger') {
    return {
      row: selected ? 'bg-error/14' : 'hover:bg-error/8',
      glyph: 'text-error',
      label: 'text-error',
    };
  }
  if (intent === 'cancel') {
    return {
      row: selected ? 'bg-white/8' : 'hover:bg-white/4',
      glyph: 'text-fg-subtle',
      label: 'text-fg-muted',
    };
  }
  return {
    row: selected ? 'bg-white/8' : 'hover:bg-white/4',
    glyph: 'text-fg-subtle',
    label: 'text-fg',
  };
}

function inputFlowControlLabel(screen: InputFlowScreen) {
  if (screen.kind === 'review') {
    return screen.content?.title ?? paletteCopy.outcome.localFeedback;
  }
  return screen.label;
}
