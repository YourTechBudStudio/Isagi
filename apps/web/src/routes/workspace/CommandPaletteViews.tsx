import { Overline } from '../../components/Overline.js';
import { paletteCopy } from '../../copy/index.js';
import { GROUP_LABELS } from '../../lib/palette/groups.js';
import type {
  CommandErrorContent,
  CommandOutcomeAction,
  CommandOutcomeTone,
  CommandResultContent,
  PaletteEntry,
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
  sel = null,
  onAction,
}: {
  content: CommandResultContent | CommandErrorContent;
  kind: 'result' | 'error';
  sel?: number | null;
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
        {outcomeActions(content).map((action, index) => (
          <button
            key={action.value}
            type="button"
            onClick={() => onAction(action.value)}
            className={`rounded-sm px-3 py-1.5 text-[12.5px] transition duration-micro ease-expo ${outcomeActionClass(action)} ${
              index === sel ? 'ring-1 ring-line/60' : ''
            }`}
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

// Staggered delays (seconds) for the ambient "working" waveform. Seven bars
// breathing out of phase read as a calm wave rather than a determinate progress
// bar making promises it can't keep — long-running work pulses, it never spins.
const WAVEFORM_DELAYS = [0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72] as const;

/**
 * Shown while a command's async run is in flight. Long-running work breathes —
 * it does not spin (design language): a slow `working` waveform plus a dry,
 * one-line status so the palette never looks frozen. `role="status"` /
 * `aria-live` announces the work to assistive tech.
 */
export function RunningPanel({
  content,
}: {
  content: { readonly title: string; readonly hint?: string | undefined };
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-28 flex-col items-center justify-center gap-4 px-6 py-9 text-center"
    >
      <span aria-hidden className="flex h-6 items-center gap-1">
        {WAVEFORM_DELAYS.map((delay, index) => (
          <span
            key={index}
            className="block h-full w-0.75 rounded-full bg-working animate-wave"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      </span>
      <div className="space-y-1.5">
        <p className="text-[13.5px] text-fg">{content.title}</p>
        {content.hint ? (
          <p className="font-mono text-[11px] leading-relaxed text-fg-subtle">{content.hint}</p>
        ) : null}
      </div>
    </div>
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

export function Tip({ mode }: { mode: 'list' | 'wizard' | 'path' | 'outcome' | 'running' }) {
  return (
    <div className="flex items-center gap-3 border-t border-line/14 px-4 py-2.5 font-mono text-[11px] text-fg-subtle">
      {mode === 'running' ? (
        <span className="opacity-70">{paletteCopy.running.tip}</span>
      ) : mode === 'outcome' ? (
        <>
          <TipKey hint={paletteCopy.tips.move}>↑↓</TipKey>
          <TipKey hint={paletteCopy.tips.run}>↵</TipKey>
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
