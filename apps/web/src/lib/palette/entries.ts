import { ArrowRight, Bot, SquareTerminal } from 'lucide-react';

import type { AgentHarness } from '@isagi/contracts';

import {
  selectSurfaceAndPersistFocus,
  startAgentSessionFromPalette,
  startTerminalSessionFromPalette,
} from '../workspace/queries.js';
import { useWorkspaceStore } from '../workspace/store.js';
import { surfaceIcon } from '../workspace/surface-presentation.js';
import { surfaceActionCommands } from './commands/surface-actions.js';
import { GLOBAL_COMMANDS } from './registry.js';
import type { PaletteCommand, PaletteContext, PaletteEntry } from './types.js';

export function assembleEntries(ctx: PaletteContext): PaletteEntry[] {
  const entries: PaletteEntry[] = [];

  for (const command of GLOBAL_COMMANDS) {
    if (command.available && !command.available(ctx)) {
      continue;
    }
    entries.push({
      id: command.id,
      label: command.label,
      icon: command.icon,
      group: 'global',
      run: () => command.run({}, ctx),
      ...(command.args?.length ? { command } : {}),
    });
  }

  const worktree = ctx.activeWorktree;
  if (worktree) {
    const activeSurfaceTitle = ctx.activeSurface?.title;
    const activeSurfaceCommands = surfaceActionCommands.filter(
      (command) => command.available?.(ctx) ?? true,
    );
    const startAgentCommand: PaletteCommand = {
      id: `worktree:${worktree.id}:start-agent-session`,
      label: 'Start agent session',
      icon: Bot,
      group: 'worktree-actions',
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
      run: async (values) => {
        await startAgentSessionFromPalette(worktree.id, values.harness as AgentHarness);
      },
    };

    for (const command of activeSurfaceCommands) {
      const sub =
        command.id === 'delete-active-pane'
          ? (activeSurfaceTitle ?? 'active pane')
          : activeSurfaceTitle;
      entries.push({
        id: command.id,
        label: command.label,
        icon: command.icon,
        group: command.group,
        command,
        run: () => command.run({}, ctx),
        ...(sub ? { sub } : {}),
      });
    }

    entries.push(
      {
        id: startAgentCommand.id,
        label: startAgentCommand.label,
        icon: startAgentCommand.icon,
        group: 'worktree-actions',
        sub: 'choose a harness',
        command: startAgentCommand,
        run: () => startAgentCommand.run({}, ctx),
      },
      {
        id: `worktree:${worktree.id}:start-terminal`,
        label: 'Start terminal',
        icon: SquareTerminal,
        group: 'worktree-actions',
        sub: 'open shell',
        run: async () => {
          await startTerminalSessionFromPalette(worktree.id);
        },
      },
    );

    for (const surface of worktree.surfaces) {
      entries.push({
        id: `surface:${surface.id}`,
        label: surface.title,
        icon: surfaceIcon(surface.kind),
        group: 'worktree-surfaces',
        sub: 'go to surface',
        run: () => selectSurfaceAndPersistFocus(worktree.id, surface.id),
      });
    }
  }

  for (const project of ctx.projects) {
    for (const candidate of project.worktrees) {
      if (candidate.id === worktree?.id) {
        continue;
      }
      entries.push({
        id: `worktree:${candidate.id}`,
        label: candidate.title,
        icon: ArrowRight,
        group: 'switch-worktree',
        sub: `${project.name} · ${candidate.branch ?? 'detached'}`,
        run: () => useWorkspaceStore.getState().selectWorktree(project.id, candidate.id),
      });
    }
  }

  return entries;
}
