import { Bot, SquareTerminal } from 'lucide-react';

import type { AgentHarness } from '@isagi/contracts';

import { worktreeActionsCopy } from '../../../copy/index.js';
import {
  startAgentSessionFromPalette,
  startTerminalSessionFromPalette,
} from '../../workspace/queries.js';
import type { ArgValues, PaletteCommand, PaletteContext } from '../types.js';

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
  args: [
    {
      kind: 'select',
      key: 'harness',
      label: 'Harness',
      options: () => [
        { value: 'pi', label: 'Pi' },
        { value: 'opencode', label: 'OpenCode' },
        { value: 'claude', label: 'Claude' },
        { value: 'codex', label: 'Codex' },
      ],
    },
  ],
  run: async (values, ctx) => {
    const worktreeId = worktreeIdFromValues(values, ctx);
    if (worktreeId === null) {
      return;
    }
    await startAgentSessionFromPalette(worktreeId, values.harness as AgentHarness);
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
