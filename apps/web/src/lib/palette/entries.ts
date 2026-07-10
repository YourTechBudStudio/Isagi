import { ArrowRight, Workflow } from 'lucide-react';

import { paletteCopy, workflowLoadFailureReasonCopy } from '../../copy/index.js';
import { activateSurface, restoreActivePaneFocus } from '../workspace/activation.js';
import { useWorkspaceStore } from '../workspace/store.js';
import { surfaceSummaryIcon } from '../workspace/surface-presentation.js';
import { sessionActionCommands } from './commands/session-actions.js';
import { surfaceActionCommands } from './commands/surface-actions.js';
import { worktreeActionCommands } from './commands/worktree-actions.js';
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
    for (const descriptor of ctx.workflowDescriptors ?? []) {
      if (descriptor.ok) {
        const occupied = ctx.activeSurfaceWorkflowSummary !== undefined;
        entries.push({
          id: `workflow:${descriptor.workflowKey}`,
          label: descriptor.manifest.title,
          icon: Workflow,
          group: 'workflows',
          sub: occupied
            ? paletteCopy.workflows.disabled.occupied
            : (descriptor.manifest.description ?? descriptor.workflowKey),
          workflow: descriptor,
          ...(occupied ? { disabled: { reason: paletteCopy.workflows.disabled.occupied } } : {}),
          run: () => {},
        });
        continue;
      }

      entries.push({
        id: `workflow:${descriptor.workflowKey}`,
        label: descriptor.workflowKey,
        icon: Workflow,
        group: 'workflows',
        sub: paletteCopy.workflows.disabled.broken,
        disabled: { reason: workflowLoadFailureReasonCopy(descriptor.reason) },
        run: () => {},
      });
    }

    const activeSurfaceTitle = ctx.activeSurface?.title;
    const activeWorktreeCommands = worktreeActionCommands.filter(
      (command) => command.available?.(ctx) ?? true,
    );
    const activeSurfaceCommands = surfaceActionCommands.filter(
      (command) => command.available?.(ctx) ?? true,
    );
    const activeSessionCommands = sessionActionCommands.filter(
      (command) => command.available?.(ctx) ?? true,
    );

    for (const command of activeWorktreeCommands) {
      const values = {
        projectId: String(worktree.projectId),
        worktreeId: String(worktree.id),
      };
      entries.push({
        id: command.id,
        label: command.label,
        icon: command.icon,
        group: command.group,
        command,
        values,
        run: () => command.run(values, ctx),
        sub: worktree.title,
      });
    }

    for (const command of activeSurfaceCommands) {
      const paneTargeted = isPaneTargetedSurfaceCommand(command.id);
      const sub = paneTargeted ? (activeSurfaceTitle ?? 'active pane') : activeSurfaceTitle;
      const values = ctx.activeSurface
        ? {
            worktreeId: String(worktree.id),
            surfaceId: String(ctx.activeSurface.id),
            ...(command.id === 'rename-active-surface' ? { title: ctx.activeSurface.title } : {}),
            ...(paneTargeted && ctx.activePaneId ? { paneId: String(ctx.activePaneId) } : {}),
          }
        : { worktreeId: String(worktree.id) };
      entries.push({
        id: command.id,
        label: command.label,
        icon: command.icon,
        group: command.group,
        command,
        values,
        run: () => command.run(values, ctx),
        ...(sub ? { sub } : {}),
      });
    }

    for (const command of activeSessionCommands) {
      const values = {
        projectId: String(worktree.projectId),
        worktreeId: String(worktree.id),
      };
      entries.push({
        id: command.id,
        label: command.label,
        icon: command.icon,
        group: command.group,
        command,
        values,
        run: () => command.run(values, ctx),
        sub: command.id === 'start-agent-session' ? 'choose a harness' : 'open shell',
      });
    }

    for (const surface of worktree.surfaces) {
      entries.push({
        id: `surface:${surface.id}`,
        label: surface.title,
        icon: surfaceSummaryIcon(surface.paneKinds),
        group: 'worktree-surfaces',
        sub: 'go to surface',
        run: () => activateSurface({ worktreeId: worktree.id, surfaceId: surface.id }),
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
        run: () => {
          useWorkspaceStore.getState().selectWorktree(project.id, candidate.id);
          restoreActivePaneFocus();
        },
      });
    }
  }

  return entries;
}

function isPaneTargetedSurfaceCommand(commandId: string) {
  return (
    commandId === 'delete-active-pane' ||
    commandId === 'split-pane-right' ||
    commandId === 'split-pane-down'
  );
}
