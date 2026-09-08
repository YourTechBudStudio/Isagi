import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';

import type { RecheckOutcome } from './fake-runtime.js';
import { SCENARIOS, scenarioById, type ScenarioId } from './seed.js';
import { useVariants } from './variants.js';

const RECHECK_OUTCOMES: readonly { readonly value: RecheckOutcome; readonly label: string }[] = [
  { value: 'restores', label: 'restores' },
  { value: 'stays_missing', label: 'still gone' },
  { value: 'reconcile_fails', label: 'reconcile fails' },
  { value: 'snapshot_fails', label: 'read fails' },
];

/**
 * The fixture's own chrome: which scenario is served, what the next recheck will
 * do and how slowly, and a comparison against today's app.
 *
 * It selects no design treatments. Every question this page was built to ask is
 * closed and its answer is hardcoded; what is left steers the recovery surface.
 *
 * Kept visually apart from the app below it — flat, mono, no halo — so nothing
 * on this bar can be mistaken for a surface Isagi ships. It is scaffolding for
 * looking at the page, and it says so.
 */
export function ScenarioBar({
  scenarioId,
  onScenarioChange,
  onOpenPalette,
}: {
  readonly scenarioId: ScenarioId;
  readonly onScenarioChange: (id: ScenarioId) => void;
  readonly onOpenPalette: () => void;
}) {
  const variants = useVariants();
  const scenario = scenarioById(scenarioId);

  // The store is the single owner of what the bar shows *and* of what the
  // runtime will do. Pushing the values across in an effect keeps the chips from
  // being a second, drifting copy of the runtime's own state.
  useEffect(() => {
    window.folderProjectFixture?.setRecheckOutcome(variants.outcome);
    window.folderProjectFixture?.setLatency(variants.latency);
  }, [variants.outcome, variants.latency]);

  return (
    <div className="flex flex-col gap-2 border-b border-line/20 bg-black/25 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {SCENARIOS.map((candidate) => (
          <Chip
            key={candidate.id}
            active={candidate.id === scenarioId}
            data-scenario={candidate.id}
            onClick={() => onScenarioChange(candidate.id)}
          >
            {candidate.label}
          </Chip>
        ))}
        <button
          type="button"
          onClick={onOpenPalette}
          className="ml-auto rounded-sm px-2 py-1 font-mono text-[10.5px] text-fg-subtle hover:text-fg"
        >
          palette · cmd+k
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Group label="next check">
          {RECHECK_OUTCOMES.map((outcome) => (
            <Chip
              key={outcome.value}
              active={variants.outcome === outcome.value}
              data-outcome={outcome.value}
              onClick={() => variants.set({ outcome: outcome.value })}
            >
              {outcome.label}
            </Chip>
          ))}
        </Group>

        <Group label="latency">
          {[0, 900].map((ms) => (
            <Chip
              key={ms}
              active={variants.latency === ms}
              data-latency={ms}
              onClick={() => variants.set({ latency: ms })}
            >
              {ms === 0 ? 'instant' : '900ms'}
            </Chip>
          ))}
        </Group>
      </div>

      <p className="font-mono text-[10.5px] text-fg-subtle opacity-55">{`// ${scenario.claim}`}</p>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[9.5px] tracking-widest text-fg-subtle uppercase opacity-70">
        {label}
      </span>
      {children}
    </div>
  );
}

function Chip({
  active,
  children,
  ...props
}: { active: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`rounded-sm border px-2 py-1 font-mono text-[10.5px] transition duration-micro ease-expo focus-visible:outline-1 focus-visible:outline-blue ${
        active
          ? 'border-blue/40 bg-blue/15 text-fg'
          : 'border-line/25 text-fg-subtle hover:border-line/45 hover:text-fg-muted'
      }`}
      {...props}
    >
      {children}
    </button>
  );
}
