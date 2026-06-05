import { ArrowRight } from 'lucide-react';

import { useWorkspaceStore } from '../workspace/store.js';
import { surfaceIcon } from '../workspace/surface-presentation.js';
import { GLOBAL_COMMANDS } from './registry.js';
import type { PaletteContext, PaletteEntry } from './types.js';

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
    for (const surface of worktree.surfaces) {
      entries.push({
        id: `surface:${surface.id}`,
        label: surface.title,
        icon: surfaceIcon(surface.kind),
        group: 'worktree-surfaces',
        sub: 'go to surface',
        run: () => useWorkspaceStore.getState().selectSurface(worktree.id, surface.id),
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
        run: () => useWorkspaceStore.getState().selectWorktree(candidate.id),
      });
    }
  }

  return entries;
}
