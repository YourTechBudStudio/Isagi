import { Bot, SquareTerminal } from 'lucide-react';

import { worktreeActionsCopy } from '../../../copy/index.js';
import { harnessLabel, parseAgentHarness } from '../../harness-labels.js';
import {
  startAgentSessionFromPalette,
  startTerminalSessionFromPalette,
} from '../../workspace/queries.js';
import type { ArgSpec, ArgValues, PaletteCommand, PaletteContext } from '../types.js';

export const harnessSelectArg: Extract<ArgSpec, { readonly kind: 'select' }> = {
  kind: 'select',
  key: 'harness',
  label: 'Harness',
  defaultSelection: 'none',
  // Only harnesses the runtime would launch right now, from the control-plane
  // snapshot threaded through the palette context — never a hardcoded list.
  options: (ctx) =>
    ctx.launchableHarnesses.map((harness) => ({ value: harness, label: harnessLabel(harness) })),
};

/**
 * Launch a fresh terminal in the target worktree. Zero-arg: it runs the moment
 * it is dispatched, whether from the palette list, a shortcut, or the rail
 * worktree context menu. The target worktree comes from explicit values when a
 * chrome affordance supplies them, falling back to the active worktree for
 * palette/keyboard use.
 */
export const startTerminalSessionCommand: PaletteCommand = {
  id: 'start-terminal-session',
  label: worktreeActionsCopy.startTerminal,
  icon: SquareTerminal,
  group: 'worktree-actions',
  available: (ctx) => Boolean(ctx.activeWorktree),
  run: async (values, ctx) => {
    const worktreeId = worktreeIdFromValues(values, ctx);
    if (worktreeId === null) {
      return;
    }
    await startTerminalSessionFromPalette(worktreeId);
  },
};

/**
 * Launch an agent session in the target worktree. The harness is collected as a
 * command-owned select step, so every entry point (palette, context menu) routes
 * through the same picker rather than reimplementing harness choice.
 */
export const startAgentSessionCommand: PaletteCommand = {
  id: 'start-agent-session',
  label: worktreeActionsCopy.startAgentSession,
  icon: Bot,
  group: 'worktree-actions',
  available: (ctx) => Boolean(ctx.activeWorktree),
  args: [harnessSelectArg],
  run: async (values, ctx) => {
    const worktreeId = worktreeIdFromValues(values, ctx);
    const harness = parseAgentHarness(values.harness);
    if (worktreeId === null || harness === null) {
      return;
    }
    await startAgentSessionFromPalette(worktreeId, harness);
  },
};

export const sessionActionCommands: readonly PaletteCommand[] = [
  startTerminalSessionCommand,
  startAgentSessionCommand,
];

function worktreeIdFromValues(values: ArgValues, ctx: PaletteContext): number | null {
  const worktreeId = Number(values.worktreeId);
  if (Number.isInteger(worktreeId)) {
    return worktreeId;
  }
  return ctx.activeWorktree?.id ?? null;
}
