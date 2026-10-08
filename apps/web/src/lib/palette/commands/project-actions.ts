import { Trash2 } from 'lucide-react';

import { projectActionsCopy } from '../../../copy/index.js';
import { deleteProjectFromPalette } from '../../workspace/queries.js';
import type { ArgValues, PaletteCommand, PaletteContext, ReviewContent } from '../types.js';

/**
 * The single owner of project deletion (ADR 0003). The palette row, the rail's
 * project menus and the missing-project canvas all open this command; only its
 * review step confirms, and only its `run` deletes.
 *
 * `available` governs palette search alone. Explicit-target triggers resolve the
 * command through `workbenchActionCommands`, so a disconnected project — which
 * is never the palette's active project — still reaches the review.
 */
export const deleteProjectCommand: PaletteCommand = {
  id: 'delete-project',
  label: projectActionsCopy.deleteProject.label,
  icon: Trash2,
  group: 'project-actions',
  feedbackSurface: 'palette',
  available: (ctx) => ctx.activeProject !== null,
  running: { title: projectActionsCopy.deleteProject.running },
  args: [
    {
      kind: 'review',
      key: 'confirm',
      label: projectActionsCopy.deleteProject.review.stepLabel,
      load: (ctx, values) => deleteProjectReview(ctx, projectIdFromValues(values, ctx)),
    },
  ],
  run: async (values, ctx) => {
    const projectId = projectIdFromValues(values, ctx);
    if (projectId === null) {
      return;
    }
    await deleteProjectFromPalette(projectId);
    return { kind: 'close' };
  },
};

export const projectActionCommands: readonly PaletteCommand[] = [deleteProjectCommand];

/** An explicit trigger's `projectId` wins; otherwise the active project. */
export function projectIdFromValues(values: ArgValues, ctx: PaletteContext): number | null {
  const explicit = Number(values.projectId);
  if (Number.isSafeInteger(explicit) && explicit > 0) {
    return explicit;
  }
  return ctx.activeProject?.id ?? null;
}

/**
 * Names the exact project and its folder. Throws when the target is unknown so
 * the review step shows its failed state and nothing destructive can run.
 */
export function deleteProjectReview(ctx: PaletteContext, projectId: number | null): ReviewContent {
  const project = ctx.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new Error(projectActionsCopy.deleteProject.gone);
  }
  const copy = projectActionsCopy.deleteProject.review;
  return {
    title: copy.title(project.name),
    body: copy.body,
    items: [{ label: project.name, detail: project.rootPath }],
    choices: [
      { value: 'delete', label: copy.confirm, intent: 'danger' },
      { value: 'cancel', label: copy.cancel, intent: 'cancel' },
    ],
  };
}
