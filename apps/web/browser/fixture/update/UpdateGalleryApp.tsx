import { Plus } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../../../src/components/Button.js';
import { Overline } from '../../../src/components/Overline.js';
import { RailUpdateFooter } from '../../../src/routes/workspace/RailUpdateFooter.js';
import {
  ACTIVITY_OPTIONS,
  INSTALLED_VERSION,
  STATE_OPTIONS,
  type FixtureStateOption,
} from './state.js';

/**
 * The update-surface fixture. One interactive rail for behavior and keyboard
 * work, and a contact sheet of every state below it for visual review.
 *
 * The rail is a stand-in for the production one — same border, gradient, blur,
 * brand block, and add-project affordance — so the footer is always judged in
 * the density and contrast it actually lives in, at the real 236px.
 */
export function UpdateGalleryApp() {
  const [stateId, setStateId] = useState('ready');
  const [activityId, setActivityId] = useState('working-3');
  const [narrow, setNarrow] = useState(false);
  const [actions, setActions] = useState<readonly string[]>([]);

  const selected = STATE_OPTIONS.find((option) => option.id === stateId) ?? STATE_OPTIONS[0]!;
  const activity =
    ACTIVITY_OPTIONS.find((option) => option.id === activityId) ?? ACTIVITY_OPTIONS[0]!;
  const railWidth = narrow ? 200 : 236;
  const record = (action: string) => setActions((previous) => [...previous, action]);

  return (
    <div className="relative z-1 h-screen overflow-y-auto px-8 py-7 text-fg">
      <header className="mb-5">
        <h1 className="font-display text-[19px] font-bold tracking-[-0.03em]">
          Rail update footer — fixture
        </h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-fg-muted">
          The ambient treatment at the real rail width. Layout never moves between states: the
          hairline track is always present and only its fill changes.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {STATE_OPTIONS.map((option) => (
          <SelectorButton
            key={option.id}
            data-state-option={option.id}
            selected={option.id === stateId}
            onClick={() => setStateId(option.id)}
          >
            {option.label}
          </SelectorButton>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-1.5">
        {ACTIVITY_OPTIONS.map((option) => (
          <SelectorButton
            key={option.id}
            data-activity-option={option.id}
            selected={option.id === activityId}
            tone="activity"
            onClick={() => setActivityId(option.id)}
          >
            {option.label}
          </SelectorButton>
        ))}
        <SelectorButton
          data-narrow-toggle
          selected={narrow}
          tone="width"
          onClick={() => setNarrow((value) => !value)}
        >
          {narrow ? 'narrow rail · 200px' : 'rail · 236px'}
        </SelectorButton>
      </div>

      <section className="flex flex-wrap items-start gap-8" data-interactive-rail>
        <RailShell width={railWidth}>
          <RailUpdateFooter
            state={selected.state}
            installedVersion={INSTALLED_VERSION}
            confirmRestart={activity.activity}
            onCheck={() => record('check')}
            onRestart={() => record('restart')}
            onRetryDownload={() => record('retry-download')}
            onOpenDownloadPage={() => record('open-download-page')}
          />
        </RailShell>
        <div className="max-w-md">
          <Overline className="mb-2">Dispatched</Overline>
          <output
            data-actions
            className="block font-mono text-[11.5px] leading-relaxed text-fg-subtle"
          >
            {actions.length === 0 ? '—' : actions.join(', ')}
          </output>
          <button
            type="button"
            data-clear-actions
            onClick={() => setActions([])}
            className="mt-3 rounded-md border border-line/25 px-2.5 py-1.5 font-mono text-[11px] text-fg-subtle transition-colors duration-micro ease-expo hover:text-fg-muted"
          >
            clear
          </button>
        </div>
      </section>

      <hr className="my-9 border-line/15" />

      <header className="mb-5">
        <h1 className="font-display text-[17px] font-bold tracking-[-0.03em]">Every state</h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-fg-muted">
          The full matrix at once, for judging how quiet the surface stays across its whole range.
        </p>
      </header>

      <section className="flex flex-wrap items-start gap-6">
        {STATE_OPTIONS.map((option) => (
          <ContactSheetEntry key={option.id} option={option} width={railWidth} record={record} />
        ))}
      </section>

      <p className="mt-9 font-mono text-[11px] text-fg-subtle opacity-40">
        {`// fixture only — no IPC, no updater, no real version`}
      </p>
    </div>
  );
}

function ContactSheetEntry({
  option,
  width,
  record,
}: {
  option: FixtureStateOption;
  width: number;
  record: (action: string) => void;
}) {
  return (
    <article data-sheet-state={option.id} style={{ width }}>
      <RailShell width={width} compact>
        <RailUpdateFooter
          state={option.state}
          installedVersion={INSTALLED_VERSION}
          onCheck={() => record('check')}
          onRestart={() => record('restart')}
          onRetryDownload={() => record('retry-download')}
          onOpenDownloadPage={() => record('open-download-page')}
        />
      </RailShell>
      <p className="mt-2 font-mono text-[11px] text-fg-subtle">{option.label}</p>
    </article>
  );
}

function SelectorButton({
  children,
  selected,
  tone = 'state',
  onClick,
  ...rest
}: {
  children: React.ReactNode;
  selected: boolean;
  tone?: 'state' | 'activity' | 'width';
  onClick: () => void;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const active = {
    state: 'border-blue/40 bg-blue/14 text-fg',
    activity: 'border-violet/40 bg-violet/14 text-fg',
    width: 'border-amber/40 bg-amber/12 text-fg',
  }[tone];
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      {...rest}
      className={`rounded-md border px-2.5 py-1.5 font-mono text-[11px] transition-colors duration-micro ease-expo ${
        selected ? active : 'border-line/22 bg-white/4 text-fg-subtle hover:text-fg-muted'
      }`}
    >
      {children}
    </button>
  );
}

function RailShell({
  children,
  width,
  compact = false,
}: {
  children: React.ReactNode;
  width: number;
  compact?: boolean;
}) {
  return (
    <aside
      className={`flex ${compact ? 'h-[240px]' : 'h-[420px]'} min-h-0 flex-col rounded-md border border-line/20 bg-linear-to-b from-elevated/55 to-canvas/30 backdrop-blur-md`}
      style={{ width }}
    >
      <div className="px-4 pt-4 pb-2.5">
        <span className="font-display text-base font-bold tracking-[-0.04em]">
          isa<span className="text-blue">gi</span>
        </span>
      </div>
      <div className="px-3 pt-1 pb-1.5">
        <Button size="sm" fullWidth icon={Plus} shortcut="⌘N">
          Add project
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-2.5 pt-1 pb-2.5">
        <Overline className="mx-2 mt-2 mb-1">Active</Overline>
        {(compact ? ['isagi'] : ['isagi', 'toph']).map((name) => (
          <div key={name} className="mx-2 mt-2 first:mt-0">
            <p className="text-[12.5px] text-fg-muted">{name}</p>
            <p className="mt-1 ml-3 text-[12px] text-fg-subtle">main</p>
            <p className="mt-1 ml-3 text-[12px] text-fg-subtle">feat/updates</p>
          </div>
        ))}
      </div>
      {children}
    </aside>
  );
}
