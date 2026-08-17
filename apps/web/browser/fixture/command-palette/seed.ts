import { Bot, SquareTerminal, Workflow } from 'lucide-react';

import type { CommandSummary } from '@isagi/contracts';

import { paletteCopy } from '../../../src/copy/index.js';
import { configuredCommandEntries } from '../../../src/lib/palette/configured-commands.js';
import type { PaletteContext, PaletteEntry } from '../../../src/lib/palette/types.js';

/**
 * Fixture seed for the `Commands` palette group.
 *
 * The rows themselves are no longer mocked: phase 02 landed the production
 * `configuredCommandEntries` and this module now calls it, injecting recording
 * effects through the dependency seam it already exposes. The parallel row
 * builder that lived here is gone, so the spec can no longer pass against a
 * palette the app does not have.
 *
 * **What remains mock-only debt, owned by phase 05:** the catalog source (the
 * hardcoded variants below stand in for a runtime read) and the forked palette
 * shell in `CommandPaletteFixtureApp.tsx`. Nothing in this file may be imported
 * by the shipped app.
 *
 * What is real and therefore genuinely reviewed here: the production section
 * assembly, the `PaletteEntry` contract, the copy, the icons, the tones, the
 * group id, and the group ordering.
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
 * The section rows, built by the **production** `configuredCommandEntries` over
 * a fixture-built context with recording effects injected. There is deliberately
 * no second branching implementation here: what the spec judges is the real
 * assembly, so a change to row shape, copy, icon, tone, or handoff order shows
 * up in this fixture instead of quietly diverging from it.
 *
 * Still mock-only: where the catalog comes from (a hardcoded variant rather than
 * a runtime read) and what the injected effects do (record a string rather than
 * call the runtime and open the drawer). Phase 05 replaces both.
 */
export function fixtureCommandEntries(
  variant: FixtureVariant,
  record: FixtureRecorder,
): readonly PaletteEntry[] {
  return configuredCommandEntries(fixtureContext(variant), {
    runCommand: async (worktreeId, commandName) => {
      record(`run:${commandName}`);
      return {
        worktreeId,
        commandName,
        summary: { name: commandName, status: 'running', ports: [] },
      };
    },
    openDrawer: (commandName) => {
      record(`open:${commandName ?? ''}`);
    },
  });
}

/**
 * The narrowest context the section reads: an active worktree (or none) plus the
 * variant's catalog state, in the same two fields `configuredCommandSection`
 * produces from a real query.
 */
function fixtureContext(variant: FixtureVariant): PaletteContext {
  return {
    projects: [],
    activeProject: null,
    activeWorktree: variant.hasActiveWorktree
      ? {
          id: WORKTREE_ID,
          projectId: 1,
          title: 'feature/commands',
          path: '/repo/isagi-feature',
          branch: 'feature/commands',
          head: 'abcdef0',
          isRoot: false,
          attention: 'idle',
          parked: false,
          surfaces: [],
          activeSurfaceId: null,
        }
      : null,
    activeSurface: null,
    activePaneId: null,
    launchableHarnesses: [],
    ...(variant.commands ? { configuredCommands: variant.commands } : {}),
    ...(variant.failure ? { configuredCommandsFailure: variant.failure } : {}),
  };
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
