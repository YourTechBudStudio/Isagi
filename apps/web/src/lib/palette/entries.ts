import { ArrowRight, Play, Square } from 'lucide-react';

import { useWorkspaceStore } from '../workspace/store.js';
import { surfaceIcon } from '../workspace/surface-presentation.js';
import { WORKTREE_ACTIONS } from '../workspace/worktree-actions.js';
import { GLOBAL_COMMANDS } from './registry.js';
import type { PaletteContext, PaletteEntry } from './types.js';

/**
 * Assemble every runnable palette entry from the current context. Global
 * commands come from the registry; the other three groups are built here from
 * workspace state. Worktree-scoped groups are omitted entirely when there is no
 * active worktree.
 */
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
    const worktreeId = worktree.id;

    for (const action of WORKTREE_ACTIONS) {
      entries.push({
        id: `action:${action.id}`,
        label: action.label,
        icon: action.icon,
        group: 'worktree-actions',
        run: () => action.run(worktreeId),
        ...(action.accent ? { accent: true } : {}),
      });
    }

    for (const command of worktree.commands) {
      const running = command.status === 'running';
      entries.push({
        id: `command:${command.id}:${running ? 'stop' : 'run'}`,
        label: `${running ? 'Stop' : 'Run'} ${command.label}`,
        icon: running ? Square : Play,
        group: 'worktree-actions',
        sub: `command · ${command.status}`,
        run: () => useWorkspaceStore.getState().toggleCommand(worktreeId, command.id),
      });
    }

    for (const surface of worktree.surfaces) {
      entries.push({
        id: `surface:${surface.id}`,
        label: surface.title,
        icon: surfaceIcon(surface.kind),
        group: 'worktree-surfaces',
        sub: 'go to surface',
        run: () => useWorkspaceStore.getState().selectSurface(worktreeId, surface.id),
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
        sub: `${project.name} · ${candidate.branch}`,
        run: () => useWorkspaceStore.getState().selectWorktree(candidate.id),
      });
    }
  }

  return entries;
}
