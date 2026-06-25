import { Plus } from 'lucide-react';

import type { PathSuggestion } from '@isagi/contracts';

import { Overline } from '../../components/Overline.js';
import { paletteCopy } from '../../copy/index.js';
import { GROUP_LABELS } from '../../lib/palette/groups.js';
import type {
  CommandErrorContent,
  CommandOutcomeAction,
  CommandOutcomeTone,
  CommandResultContent,
  Option,
  PaletteEntry,
  ReviewChoice,
  ReviewContent,
} from '../../lib/palette/types.js';
import { modKey } from '../../lib/platform.js';

export function outcomeActions(content: CommandResultContent | CommandErrorContent) {
  return content.actions?.length
    ? content.actions
    : [{ value: 'close', label: paletteCopy.outcome.close } satisfies CommandOutcomeAction];
}

export function OutcomePanel({
  content,
  kind,
  onAction,
}: {
  content: CommandResultContent | CommandErrorContent;
  kind: 'result' | 'error';
  onAction: (value: string) => void;
}) {
  const tone = kind === 'error' ? (content.tone ?? 'danger') : (content.tone ?? 'info');
  const toneClass = outcomeToneClass(tone);
  return (
    <div className="px-3 py-3">
      <div className={`rounded-md border p-3 ${toneClass.frame}`}>
        <p className={`text-[13.5px] font-medium ${toneClass.title}`}>{content.title}</p>
        {content.body && (
          <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">{content.body}</p>
        )}
        {content.diagnostic && (
          <div className="mt-3 rounded-sm border border-line/18 bg-scrim/28 p-2">
            <p className="font-mono text-[10.5px] text-fg-subtle">
              {content.diagnostic.label || paletteCopy.outcome.diagnostic}
            </p>
            <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-fg-muted">
              {content.diagnostic.detail}
            </pre>
          </div>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {outcomeActions(content).map((action) => (
          <button
            key={action.value}
            type="button"
            onClick={() => onAction(action.value)}
            className={`rounded-sm px-3 py-1.5 text-[12.5px] transition duration-micro ease-expo ${outcomeActionClass(action)}`}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function outcomeToneClass(tone: CommandOutcomeTone) {
  if (tone === 'success') {
    return { frame: 'border-green/22 bg-green/8', title: 'text-green' };
  }
  if (tone === 'warning') {
    return { frame: 'border-amber/24 bg-amber/8', title: 'text-amber' };
  }
  if (tone === 'danger') {
    return { frame: 'border-error/24 bg-error/8', title: 'text-error' };
  }
  return { frame: 'border-blue/20 bg-blue/8', title: 'text-fg' };
}

function outcomeActionClass(action: CommandOutcomeAction) {
  if (action.intent === 'danger') {
    return 'bg-error/14 text-error hover:bg-error/20';
  }
  if (action.intent === 'primary') {
    return 'bg-blue/16 text-blue hover:bg-blue/22';
  }
  if (action.intent === 'cancel') {
    return 'bg-white/5 text-fg-muted hover:bg-white/8';
  }
  return 'bg-white/8 text-fg hover:bg-white/12';
}

export function EntryList({
  items,
  sel,
  onPick,
}: {
  items: readonly PaletteEntry[];
  sel: number | null;
  onPick: (index: number) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="px-3 py-6 text-center font-mono text-[12px] text-fg-subtle">
        {paletteCopy.emptySearch}
      </p>
    );
  }

  let lastGroup: string | null = null;
  return (
    <>
      {items.map((entry, index) => {
        const Icon = entry.icon;
        const header = entry.group !== lastGroup ? GROUP_LABELS[entry.group] : null;
        lastGroup = entry.group;
        const disabled = entry.disabled !== undefined;
        return (
          <div key={entry.id}>
            {header && <GroupHeader label={header} />}
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                if (!disabled) onPick(index);
              }}
              className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left transition duration-micro ease-expo disabled:cursor-not-allowed ${
                disabled ? 'opacity-45' : index === sel ? 'bg-white/8' : 'hover:bg-white/4'
              }`}
            >
              <Icon
                size={16}
                className={
                  entry.accent && !disabled
                    ? 'text-violet'
                    : index === sel && !disabled
                      ? 'text-fg'
                      : 'text-fg-subtle'
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-fg">{entry.label}</span>
                {entry.sub && (
                  <span className="block truncate font-mono text-[10.5px] text-fg-subtle">
                    {entry.sub}
                  </span>
                )}
              </span>
              {entry.command?.args?.length && !disabled ? (
                <span className="font-mono text-[10.5px] text-fg-subtle">›</span>
              ) : null}
            </button>
          </div>
        );
      })}
    </>
  );
}

export function TextStep({
  value,
  placeholder,
}: {
  value: string;
  placeholder: string | undefined;
}) {
  return (
    <div className="px-3 py-4">
      <p className="font-mono text-[11px] text-fg-subtle">
        {value ? paletteCopy.textStep.useValue : (placeholder ?? paletteCopy.textStep.typeThenUse)}
      </p>
      {value && (
        <p className="mt-2 rounded-sm border border-line/22 bg-white/6 px-3 py-2 font-mono text-[13px] text-fg">
          {value}
        </p>
      )}
    </div>
  );
}

export function PathOptions({
  suggestions,
  value,
  loading,
  stale,
  error,
  sel,
  onPick,
}: {
  suggestions: readonly PathSuggestion[];
  value: string;
  loading: boolean;
  stale: boolean;
  error: string | null;
  sel: number | null;
  onPick: (index: number) => void;
}) {
  if (error) {
    return <p className="wrap-break-word px-3 py-4 font-mono text-[12px] text-error">{error}</p>;
  }

  if (suggestions.length === 0) {
    return (
      <div className="px-3 py-4" aria-busy={loading}>
        <p className="font-mono text-[11px] text-fg-subtle">
          {loading
            ? paletteCopy.pathStep.searching
            : value
              ? paletteCopy.pathStep.addPath
              : paletteCopy.pathStep.typeRepositoryRoot}
        </p>
        {value && (
          <p className="mt-2 rounded-sm border border-line/22 bg-white/6 px-3 py-2 font-mono text-[13px] text-fg">
            {value}
          </p>
        )}
      </div>
    );
  }

  return (
    <div aria-busy={loading}>
      {suggestions.map((suggestion, index) => (
        <button
          type="button"
          key={suggestion.path}
          disabled={stale}
          onClick={() => onPick(index)}
          className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left transition duration-micro ease-expo ${
            stale ? 'opacity-55' : index === sel ? 'bg-white/8' : 'hover:bg-white/4'
          }`}
        >
          <span className="w-4 text-center font-mono text-[12px] text-fg-subtle">
            {!stale && index === sel ? '●' : '○'}
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

/**
 * Per-choice colour for a review step. `danger` is the only place red appears in
 * the wizard (reserved for the destructive accept); `cancel` reads as a quiet
 * back-out; everything else is the neutral choice tone.
 */
function reviewChoiceTone(intent: ReviewChoice['intent'], selected: boolean) {
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

export function ReviewStep({
  content,
  error,
  loading,
  sel,
  onPick,
}: {
  content: ReviewContent | null;
  error: string | null;
  loading: boolean;
  sel: number | null;
  onPick: (index: number) => void;
}) {
  if (error) {
    return <p className="px-3 py-4 font-mono text-[12px] text-error">{error}</p>;
  }
  if (loading || !content) {
    return (
      <p className="px-3 py-4 font-mono text-[12px] text-fg-subtle">
        {paletteCopy.reviewStep.loading}
      </p>
    );
  }

  return (
    <div className="px-3 py-3">
      <p className="text-[13.5px] font-medium text-fg">{content.title}</p>
      <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">{content.body}</p>
      {content.items.length > 0 && (
        <div className="mt-3 space-y-1.5 rounded-md border border-line/20 bg-white/5 p-2">
          {content.items.map((item, index) => (
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
        {content.choices.map((choice, index) => {
          const tone = reviewChoiceTone(choice.intent, index === sel);
          return (
            <button
              type="button"
              key={choice.value}
              onClick={() => onPick(index)}
              className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left ${tone.row}`}
            >
              <span className={`w-4 text-center font-mono text-[12px] ${tone.glyph}`}>
                {index === sel ? '●' : '○'}
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

export function WizardOptions({
  options,
  sel,
  error,
  hint,
  loading,
  onPick,
}: {
  options: readonly Option[];
  sel: number | null;
  error?: string | null | undefined;
  hint?: string | undefined;
  loading?: boolean | undefined;
  onPick: (index: number) => void;
}) {
  if (error) {
    return <p className="px-3 py-4 font-mono text-[12px] text-error">{error}</p>;
  }

  return (
    <>
      {hint && <p className="px-3 py-2 font-mono text-[11px] text-fg-subtle">{hint}</p>}
      {loading && (
        <p className="px-3 py-4 font-mono text-[12px] text-fg-subtle">
          {paletteCopy.wizardStep.loading}
        </p>
      )}
      {options.map((option, index) =>
        option.create ? (
          <button
            type="button"
            key={option.value}
            onClick={() => onPick(index)}
            className={`mx-1 my-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-md border px-3 py-2.25 text-left transition duration-micro ease-expo ${
              index === sel
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
            onClick={() => onPick(index)}
            className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.25 text-left ${
              index === sel ? 'bg-white/8' : 'hover:bg-white/4'
            }`}
          >
            <span className="w-4 text-center font-mono text-[12px] text-fg-subtle">
              {index === sel ? '●' : '○'}
            </span>
            <span className="flex-1 truncate text-[13.5px] text-fg">
              {option.label ?? option.value}
            </span>
            {option.isDefault && <span className="font-mono text-[10.5px] text-cyan">default</span>}
            {option.hint && (
              <span className="font-mono text-[10.5px] text-fg-subtle">{option.hint}</span>
            )}
          </button>
        ),
      )}
    </>
  );
}

function GroupHeader({ label }: { label: string }) {
  return <Overline className="px-2.5 pt-2 pb-1 text-[9.5px]">{label}</Overline>;
}

function TipKey({ children, hint }: { children: string; hint: string }) {
  return (
    <span>
      <span className="text-fg-muted">{children}</span> {hint}
    </span>
  );
}

export function Tip({ mode }: { mode: 'list' | 'wizard' | 'path' | 'outcome' }) {
  return (
    <div className="flex items-center gap-3 border-t border-line/14 px-4 py-2.5 font-mono text-[11px] text-fg-subtle">
      {mode === 'outcome' ? (
        <>
          <TipKey hint={paletteCopy.tips.close}>esc</TipKey>
        </>
      ) : mode === 'path' ? (
        <>
          <TipKey hint={paletteCopy.tips.cycle}>↑↓</TipKey>
          <TipKey hint={paletteCopy.tips.fill}>tab</TipKey>
          <TipKey hint={paletteCopy.tips.fillOrAdd}>↵</TipKey>
          <TipKey hint={paletteCopy.tips.back}>esc</TipKey>
          <span className="ml-auto opacity-70">{paletteCopy.pathStep.goDeeper}</span>
        </>
      ) : mode === 'wizard' ? (
        <>
          <TipKey hint={paletteCopy.tips.cycle}>↑↓</TipKey>
          <TipKey hint={paletteCopy.tips.select}>↵</TipKey>
          <TipKey hint={paletteCopy.tips.back}>esc</TipKey>
        </>
      ) : (
        <>
          <TipKey hint={paletteCopy.tips.move}>↑↓</TipKey>
          <TipKey hint={paletteCopy.tips.run}>↵</TipKey>
          <TipKey hint={paletteCopy.tips.close}>esc</TipKey>
          <span className="ml-auto opacity-70">{paletteCopy.tips.anywhere(modKey)}</span>
        </>
      )}
    </div>
  );
}
