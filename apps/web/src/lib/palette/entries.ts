import { ArrowRight, TriangleAlert, Workflow } from 'lucide-react';

import {
  paletteCopy,
  workflowLoadFailureReasonCopy,
  worktreeActionsCopy,
} from '../../copy/index.js';
import { activateSurface, restoreActivePaneFocus } from '../workspace/activation.js';
import { useWorkspaceStore } from '../workspace/store.js';
import { surfaceSummaryIcon } from '../workspace/surface-presentation.js';
import { editorActionCommands } from './commands/editor-actions.js';
import { sessionActionCommands } from './commands/session-actions.js';
import { surfaceActionCommands } from './commands/surface-actions.js';
import { worktreeActionCommands } from './commands/worktree-actions.js';
import { configuredCommandEntries } from './configured-commands.js';
import { GLOBAL_COMMANDS } from './registry.js';
import type { CommandErrorContent, PaletteContext, PaletteEntry } from './types.js';

/**
 * Builds a selectable error-detail row from already-formed error content. The row
 * reads as a diagnostic (error-toned `TriangleAlert`, no launch affordance) and
 * its `run()` returns an error outcome that opens the palette's `OutcomePanel`;
 * it has no workflow launch descriptor, so it can never reach workflow start.
 * Shared by broken winning packages and whole-list discovery failures.
 */
export function workflowFailureEntry(input: {
  readonly id: string;
  readonly label: string;
  readonly sub: string;
  readonly content: CommandErrorContent;
}): PaletteEntry {
  return {
    id: input.id,
    label: input.label,
    icon: TriangleAlert,
    group: 'workflows',
    sub: input.sub,
    tone: 'error',
    run: () => ({ kind: 'error', content: input.content }),
  };
}

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
    // A whole-list discovery failure replaces the per-key descriptor rows with
    // one synthetic detail row, but never suppresses the unrelated groups below.
    if (ctx.workflowFailure) {
      entries.push(
        workflowFailureEntry({
          id: 'workflow-failure',
          label: ctx.workflowFailure.label,
          sub: ctx.workflowFailure.sub,
          content: ctx.workflowFailure.content,
        }),
      );
    } else {
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

        // A broken winning package: visible, selectable, and reason-specific, but
        // never runnable. Its `diagnostic` (winner + shadowed paths) is framed in
        // the outcome panel only when the runtime supplied one.
        entries.push(
          workflowFailureEntry({
            id: `workflow:${descriptor.workflowKey}`,
            label: descriptor.workflowKey,
            sub: paletteCopy.workflows.failure.broken.sub,
            content: {
              title: paletteCopy.workflows.failure.broken.title,
              body: workflowLoadFailureReasonCopy(descriptor.reason),
              ...(descriptor.diagnostic
                ? {
                    diagnostic: {
                      label: paletteCopy.workflows.failure.diagnosticLabel,
                      detail: descriptor.diagnostic,
                    },
                  }
                : {}),
            },
          }),
        );
      }
    }

    // Between the workflow rows and the worktree actions: `EntryList` starts a
    // new group header wherever `group` changes and `filterEntries` preserves
    // assembly order, so this placement is what makes the section contiguous and
    // puts `Commands` between `Workflows` and `This worktree`.
    entries.push(...configuredCommandEntries(ctx));

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
    const activeEditorCommands = editorActionCommands.filter(
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

    // Its own loop rather than a fourth branch inside the session one: an editor
    // context is not a session, and the two lists have different subtitles for
    // reasons that will keep diverging.
    for (const command of activeEditorCommands) {
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
        sub: worktreeActionsCopy.openEditorHint,
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
