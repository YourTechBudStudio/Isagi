import { Bot } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AttentionDot } from '../../components/AttentionDot.js';
import { Button } from '../../components/Button.js';
import { MonoAside } from '../../components/MonoAside.js';
import { Overline } from '../../components/Overline.js';
import { TerminalRevealSlot } from '../workspace/terminal-reveal/index.js';
import { MockTerminalBody } from './MockTerminalBody.js';
import {
  LONG_TITLE,
  SHORT_TITLE,
  TERMINAL_FIXTURES,
  type TerminalFixture,
} from './terminalCacheFixtures.js';

/**
 * Development-only gallery for the terminal presentation cache's visual states.
 *
 * Reachable at `/__dev/terminal-cache-states` under `pnpm dev` only — `App.tsx`
 * gates the route behind `import.meta.env.DEV`, so the route, this page, and its
 * fixtures are eliminated from production builds. Nothing here touches a socket,
 * a cache entry, or a real xterm; the terminal bodies are static markup.
 */

type LayoutId = 'pane' | 'split' | 'zen';

const LAYOUTS: Record<LayoutId, { readonly label: string; readonly frame: string }> = {
  pane: { label: 'Pane', frame: 'h-[22rem] w-full max-w-[46rem]' },
  split: { label: 'Compact split', frame: 'h-[16rem] w-full max-w-[23rem]' },
  zen: { label: 'Zen', frame: 'h-[34rem] w-full max-w-[72rem]' },
};

const REVEAL_DELAY_MS = 1400;

export function TerminalCacheStatesPage() {
  const [fixtureId, setFixtureId] = useState(TERMINAL_FIXTURES[0]!.id);
  const [layout, setLayout] = useState<LayoutId>('pane');
  const [focused, setFocused] = useState(true);
  const [errored, setErrored] = useState(false);
  const [longTitle, setLongTitle] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [sequenceRevealed, setSequenceRevealed] = useState<boolean | null>(null);
  const sequenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fixture =
    TERMINAL_FIXTURES.find((entry) => entry.id === fixtureId) ?? TERMINAL_FIXTURES[0]!;
  const revealed = sequenceRevealed ?? fixture.revealed;

  const clearSequence = useCallback(() => {
    if (sequenceTimer.current !== null) {
      clearTimeout(sequenceTimer.current);
      sequenceTimer.current = null;
    }
    setSequenceRevealed(null);
  }, []);

  useEffect(() => clearSequence, [clearSequence]);

  const playSequence = useCallback(() => {
    if (sequenceTimer.current !== null) clearTimeout(sequenceTimer.current);
    setFixtureId('parsed-not-rendered');
    setSequenceRevealed(false);
    sequenceTimer.current = setTimeout(() => {
      sequenceTimer.current = null;
      setSequenceRevealed(true);
    }, REVEAL_DELAY_MS);
  }, []);

  const selectFixture = useCallback(
    (next: TerminalFixture['id']) => {
      clearSequence();
      setFixtureId(next);
    },
    [clearSequence],
  );

  const paneProps = {
    fixture,
    revealed,
    reducedMotion,
    focused,
    errored,
    title: longTitle ? LONG_TITLE : SHORT_TITLE,
  };

  return (
    <div className="canvas-atmosphere flex h-screen flex-col overflow-hidden">
      <header className="flex items-baseline gap-4 border-b border-line/15 px-6 py-4">
        <div>
          <Overline>Dev fixture</Overline>
          <h1 className="font-display text-[18px] font-medium text-fg">Terminal cache states</h1>
        </div>
        <MonoAside className="ml-auto">
          {'// dev build only — no socket, no xterm, no cache'}
        </MonoAside>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 space-y-5 overflow-y-auto border-r border-line/15 px-5 py-5">
          <Group label="State">
            {TERMINAL_FIXTURES.map((entry) => (
              <Choice
                key={entry.id}
                active={sequenceRevealed === null && fixtureId === entry.id}
                onSelect={() => selectFixture(entry.id)}
              >
                {entry.label}
              </Choice>
            ))}
          </Group>

          <Group label="Layout">
            {(Object.keys(LAYOUTS) as LayoutId[]).map((id) => (
              <Choice key={id} active={layout === id} onSelect={() => setLayout(id)}>
                {LAYOUTS[id].label}
              </Choice>
            ))}
          </Group>

          <Group label="Modifiers">
            <Toggle active={focused} onSelect={() => setFocused((value) => !value)}>
              Focus border
            </Toggle>
            <Toggle active={errored} onSelect={() => setErrored((value) => !value)}>
              Error tone
            </Toggle>
            <Toggle active={longTitle} onSelect={() => setLongTitle((value) => !value)}>
              Long session title
            </Toggle>
            <Toggle active={reducedMotion} onSelect={() => setReducedMotion((value) => !value)}>
              Reduced motion
            </Toggle>
            <p className="pt-1 text-[12px] leading-relaxed text-fg-subtle">
              Stills the dot and cuts the reveal. The sweep&rsquo;s own still state is pure CSS —
              see it with devtools ▸ Rendering ▸ Emulate prefers-reduced-motion.
            </p>
          </Group>

          <div className="space-y-2 pt-1">
            <Button variant="secondary" size="sm" onClick={playSequence}>
              Play cold → reveal
            </Button>
            <p className="text-[12px] leading-relaxed text-fg-subtle">
              Holds the cover for {REVEAL_DELAY_MS}ms over already-parsed content, then fades it on
              the render signal.
            </p>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col items-center gap-5 overflow-auto px-8 py-8">
          {layout === 'split' ? (
            <div className="flex w-full max-w-188 gap-3">
              <MockPane {...paneProps} className={LAYOUTS.split.frame} />
              <MockPane
                {...paneProps}
                className={LAYOUTS.split.frame}
                focused={false}
                fixture={TERMINAL_FIXTURES[2]!}
                revealed
                title={SHORT_TITLE}
              />
            </div>
          ) : (
            <MockPane {...paneProps} className={LAYOUTS[layout].frame} />
          )}

          <p className="max-w-184 text-[13px] leading-relaxed text-fg-subtle">
            <span className="text-fg-muted">{fixture.label}. </span>
            {fixture.claim}
          </p>
        </main>
      </div>
    </div>
  );
}

/**
 * A stand-in for `PtyPane`'s chrome — header, notice strip, terminal region, and
 * an out-of-viewport recovery row. Deliberately a copy rather than an extraction:
 * Phase 04 reworks the real pane's terminal branch, and this gallery is deleted
 * with the mock phase.
 */
function MockPane({
  fixture,
  revealed,
  reducedMotion,
  focused,
  errored,
  title,
  className,
}: {
  readonly fixture: TerminalFixture;
  readonly revealed: boolean;
  readonly reducedMotion: boolean;
  readonly focused: boolean;
  readonly errored: boolean;
  readonly title: string;
  readonly className: string;
}) {
  const tone = errored ? 'border-error/35' : focused ? 'border-blue/40' : 'border-line/20';

  return (
    <section
      className={`flex min-w-0 flex-col overflow-hidden rounded-md border bg-elevated/50 backdrop-blur-sm ${tone} ${className}`}
    >
      <div className="flex min-h-9 items-center gap-2 border-b border-line/15 px-3 py-2">
        <Bot size={13} className="text-fg-subtle" />
        <AttentionDot state={fixture.attention} />
        <span className="truncate font-mono text-[11.5px] text-fg-muted">{title}</span>
      </div>

      {fixture.notice ? (
        <div className="border-b border-line/12 px-3 py-1.5 font-mono text-[10.5px] text-fg-subtle">
          {fixture.notice}
        </div>
      ) : null}

      <TerminalRevealSlot
        revealed={revealed}
        reducedMotion={reducedMotion}
        hostContent={<MockTerminalBody kind={fixture.body} />}
      />

      {fixture.recovery ? (
        <div className="flex items-center gap-2 border-t border-line/15 px-3 py-2">
          <Button variant="secondary" size="sm">
            {fixture.recovery.primary}
          </Button>
          <Button variant="ghost" size="sm">
            {fixture.recovery.secondary}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function Group({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <Overline>{label}</Overline>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Choice({
  active,
  onSelect,
  children,
}: {
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`block w-full rounded-sm px-2 py-1 text-left font-mono text-[11.5px] transition-colors duration-micro ease-expo ${
        active ? 'bg-overlay/60 text-fg' : 'text-fg-subtle hover:bg-overlay/30 hover:text-fg-muted'
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({
  active,
  onSelect,
  children,
}: {
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left font-mono text-[11.5px] text-fg-subtle transition-colors duration-micro ease-expo hover:text-fg-muted"
    >
      <span
        className={`size-1.75 rounded-full ${active ? 'bg-waiting' : 'bg-line/50'}`}
        aria-hidden
      />
      {children}
    </button>
  );
}
