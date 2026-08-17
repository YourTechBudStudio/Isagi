import { Activity, Bot, Play, SquareTerminal, TriangleAlert, Workflow } from 'lucide-react';

import type { CommandSummary } from '@isagi/contracts';

import { paletteCopy } from '../../../src/copy/index.js';
import type { PaletteEntry } from '../../../src/lib/palette/types.js';

/**
 * Fixture seed for the `Commands` palette group.
 *
 * **This whole module is mock-only debt.** Phase 02 owns the real
 * `configuredCommandSection` / `configuredCommandEntries` in
 * `src/lib/palette/configured-commands.ts`, and phase 05 replaces everything
 * here with the production section over a contract-shaped fake runtime. Nothing
 * in this file may be imported by the shipped app, and the row shapes below are
 * a deliberate stand-in for the production assembly, not a second definition of
 * it — when the two disagree, production wins and this file is wrong.
 *
 * What is real: the `PaletteEntry` contract, the copy, the icons, the group id,
 * and the group ordering. What is mocked: where the catalog comes from, and what
 * selecting a row does.
 */

/** Which failure the catalog read produced, mirroring the phase-02 mapping. */
export type FixtureFailureKind = 'config_error' | 'unavailable';

export interface FixtureVariant {
  readonly id: string;
  readonly label: string;
  /** Shown under the controls so a human reviewer knows what they are judging. */
  readonly note: string;
  /** `false` models "no active worktree": the section is absent entirely. */
  readonly hasActiveWorktree: boolean;
  readonly commands?: readonly CommandSummary[];
  readonly failure?: FixtureFailureKind;
}

const WORKTREE_ID = 4;

export const VARIANTS: readonly FixtureVariant[] = [
  {
    id: 'mixed',
    label: 'Mixed catalog',
    note: 'The everyday case: some commands up, some not, one with ports.',
    hasActiveWorktree: true,
    commands: [
      { name: 'dev', status: 'idle', ports: [] },
      { name: 'api', status: 'running', ports: [8080] },
      { name: 'storybook', status: 'running', ports: [] },
      { name: 'typecheck', status: 'exited', ports: [] },
    ],
  },
  {
    id: 'startable',
    label: 'Every startable status',
    note: 'idle · stopped · exited · failed all render as one ordinary startable row. A failed last run is still startable, because starting a fresh run is what selecting it does.',
    hasActiveWorktree: true,
    commands: [
      { name: 'dev', status: 'idle', ports: [] },
      { name: 'api', status: 'stopped', ports: [] },
      { name: 'worker', status: 'exited', ports: [] },
      { name: 'migrate', status: 'failed', ports: [] },
    ],
  },
  {
    id: 'running',
    label: 'Running, with and without ports',
    note: 'The running row must never read as a restart. Ports use the drawer’s :port notation.',
    hasActiveWorktree: true,
    commands: [
      { name: 'worker', status: 'running', ports: [] },
      { name: 'api', status: 'running', ports: [8080] },
      { name: 'dev:api', status: 'running', ports: [8080, 9229] },
      {
        name: 'a-really-long-configured-command-name-that-has-to-truncate',
        status: 'idle',
        ports: [],
      },
    ],
  },
  {
    id: 'config-error',
    label: 'Invalid config',
    note: 'One error-toned row, alone in the group. Neighbouring groups are untouched — a broken command config must not make the whole palette look broken.',
    hasActiveWorktree: true,
    failure: 'config_error',
  },
  {
    id: 'unavailable',
    label: 'Catalog unreadable',
    note: 'A terminal read failure beats retained stale data, so no command rows appear beside it.',
    hasActiveWorktree: true,
    failure: 'unavailable',
  },
  {
    id: 'empty',
    label: 'Empty valid catalog',
    note: 'Zero rows, so no group header at all. No placeholder row and no “nothing configured” line — the palette is a launcher, not a report.',
    hasActiveWorktree: true,
    commands: [],
  },
  {
    id: 'no-worktree',
    label: 'No active worktree',
    note: 'The section is out of scope entirely, exactly as the worktree-scoped groups already behave.',
    hasActiveWorktree: false,
  },
];

/** Records what a selection did, in the order it happened. */
export type FixtureRecorder = (action: string) => void;

/**
 * The mock stand-in for phase 02's `configuredCommandEntries`. The branch is
 * frozen on the summary's status at assembly time, and the startable branch
 * awaits its run *before* opening details, so the recorded order proves the
 * handoff rather than assuming it.
 */
export function fixtureCommandEntries(
  variant: FixtureVariant,
  record: FixtureRecorder,
): readonly PaletteEntry[] {
  if (!variant.hasActiveWorktree) return [];

  if (variant.failure) {
    const copy =
      variant.failure === 'config_error'
        ? paletteCopy.commands.failure.configError
        : paletteCopy.commands.failure.unavailable;
    return [
      {
        id: 'configured-commands-failure',
        label: copy.label,
        icon: TriangleAlert,
        group: 'worktree-commands',
        sub: copy.sub,
        tone: 'error',
        // No command focus argument: the drawer's diagnostic surface renders
        // regardless, and any prior selection is preserved.
        run: () => {
          record('open:');
        },
      },
    ];
  }

  return (variant.commands ?? []).map((command) =>
    command.status === 'running'
      ? {
          id: `command:${WORKTREE_ID}:${command.name}`,
          label: command.name,
          icon: Activity,
          group: 'worktree-commands',
          sub: paletteCopy.commands.sub.running(command.ports),
          tone: 'working',
          run: () => {
            record(`open:${command.name}`);
          },
        }
      : {
          id: `command:${WORKTREE_ID}:${command.name}`,
          label: command.name,
          icon: Play,
          group: 'worktree-commands',
          sub: paletteCopy.commands.sub.run,
          run: async () => {
            record(`run:${command.name}`);
            await Promise.resolve();
            record(`open:${command.name}`);
          },
        },
  );
}

/**
 * Static rows from the groups that bracket `Commands`. They exist so the section
 * is always judged in its real neighbourhood — placement, header contiguity, and
 * whether an error row bleeds into groups it has nothing to do with.
 */
export function neighbourEntries(record: FixtureRecorder): readonly PaletteEntry[] {
  const inert =
    (id: string): (() => void) =>
    () =>
      record(`neighbour:${id}`);
  return [
    {
      id: 'neighbour:workflow',
      label: 'Ship a story',
      icon: Workflow,
      group: 'workflows',
      sub: paletteCopy.workflows.start,
      run: inert('workflow'),
    },
    {
      id: 'neighbour:terminal',
      label: 'Start terminal',
      icon: SquareTerminal,
      group: 'worktree-actions',
      sub: 'open shell',
      run: inert('terminal'),
    },
    {
      id: 'neighbour:agent',
      label: 'Start agent session',
      icon: Bot,
      group: 'worktree-actions',
      sub: 'choose a harness',
      run: inert('agent'),
    },
  ];
}
