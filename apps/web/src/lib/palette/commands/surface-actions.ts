import { Schema } from 'effect';
import { Mic, PanelBottom, PanelRight, Pencil, Trash2 } from 'lucide-react';

import {
  agentSessionInteractionOriginSchema,
  type SplitPaneDirection,
  type SurfaceDetail,
  type SurfacePane,
  type WorkflowRunSummary,
} from '@isagi/shared/contracts';

import { fluidcastCopy, surfaceActionsCopy } from '../../../copy/index.js';
import { interactionOrigin, setPaneInteraction } from '../../fluidcast/commits.js';
import { parseAgentHarness } from '../../harness-labels.js';
import {
  deleteSurfaceFromPalette,
  deleteSurfacePaneFromPalette,
  renameSurfaceTitleFromPalette,
  splitPaneFromPalette,
} from '../../workspace/commits.js';
import { resolveActivePaneId } from '../../workspace/model.js';
import { readFresh, surfaceDetailAtom } from '../../workspace/queries.js';
import { UserVisibleError } from '../../workspace/runtime-data.js';
import { attachedRunForSurface } from '../../workspace/workflow/attached.js';
import { attachedRunsAtom, attachedRunsCurrentAtom } from '../../workspace/workflow/queries.js';
import type { ArgValues, PaletteCommand, PaletteContext, ReviewContent } from '../types.js';
import { harnessSelectArg } from './session-actions.js';

const TITLE_MAX_LENGTH = 80;

const isInteractionOrigin = Schema.is(agentSessionInteractionOriginSchema);

export const renameActiveSurfaceCommand: PaletteCommand = {
  id: 'rename-active-surface',
  label: 'Rename active surface',
  icon: Pencil,
  group: 'worktree-actions',
  available: (ctx) => Boolean(ctx.activeSurface),
  preflight: (ctx, values) => {
    const surface = ctx.activeSurface;
    const explicitSurfaceId = Number(values.surfaceId);
    if (Number.isInteger(explicitSurfaceId)) {
      return {
        mode: 'palette',
        values: {
          surfaceId: String(explicitSurfaceId),
          ...(values.worktreeId ? { worktreeId: values.worktreeId } : {}),
          title: values.title ?? surface?.title ?? '',
        },
      };
    }
    if (!surface) {
      return { mode: 'unavailable' };
    }
    return { mode: 'palette', values: { surfaceId: String(surface.id), title: surface.title } };
  },
  args: [
    {
      kind: 'text',
      key: 'title',
      label: 'Surface title',
      placeholder: surfaceActionsCopy.renameSurface.placeholder,
      default: (_ctx, values) => values.title ?? '',
    },
  ],
  run: async (values, ctx) => {
    const surfaceId = readSurfaceId(values, ctx);
    if (!surfaceId) {
      return;
    }
    const title = (values.title ?? '').trim();
    if (!title) {
      throw new UserVisibleError(surfaceActionsCopy.renameSurface.emptyTitle);
    }
    if (title.length > TITLE_MAX_LENGTH) {
      throw new UserVisibleError(surfaceActionsCopy.renameSurface.titleTooLong);
    }
    await ctx.app(renameSurfaceTitleFromPalette(surfaceId, title));
  },
};

/**
 * Deleting a surface also cancels the workflow run still going on it (the runtime does that in the
 * same delete). That is never silent: with an unfinished run attached, or while Isagi can't be sure
 * which runs are attached, the command opens on a review in the palette, wherever it was
 * triggered from; otherwise it deletes at once.
 */
export const deleteActiveSurfaceCommand: PaletteCommand = {
  id: 'delete-active-surface',
  label: 'Delete active surface',
  icon: Trash2,
  group: 'worktree-actions',
  running: { title: surfaceActionsCopy.deleteSurface.running },
  available: (ctx) => Boolean(ctx.activeSurface),
  args: [
    {
      kind: 'review',
      key: 'confirm',
      label: surfaceActionsCopy.deleteSurface.review.stepLabel,
      load: (ctx, values) => deleteSurfaceReview(ctx, activeSurfaceTargetFromValues(values, ctx)),
    },
  ],
  preflight: (ctx, values) => {
    const target = activeSurfaceTargetFromValues(values, ctx);
    if (!target) {
      return { mode: 'unavailable' };
    }
    const targetValues = {
      surfaceId: String(target.surfaceId),
      worktreeId: String(target.worktreeId),
    };
    return workflowOn(ctx, target.surfaceId).kind === 'none'
      ? { mode: 'run', values: targetValues }
      : { mode: 'palette', values: targetValues };
  },
  run: async (values, ctx) => {
    const target = activeSurfaceTargetFromValues(values, ctx);
    if (!target) {
      return;
    }
    await ctx.app(deleteSurfaceFromPalette(target));
    return { kind: 'close' };
  },
};

/**
 * What deleting the surface would cancel: its unfinished run, nothing (no run, or a finished one,
 * which is only detached), or unknown while the attached runs are not the runtime's current answer
 * (before this connection's snapshot, or while the event socket is down).
 */
function workflowOn(
  ctx: PaletteContext,
  surfaceId: number,
):
  | { readonly kind: 'unfinished'; readonly run: WorkflowRunSummary }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown' } {
  const runs = ctx.registry.get(attachedRunsAtom);
  if (runs === undefined || !ctx.registry.get(attachedRunsCurrentAtom)) return { kind: 'unknown' };
  const run = attachedRunForSurface(runs, surfaceId);
  return run && unfinishedRunStatuses.has(run.status)
    ? { kind: 'unfinished', run }
    : { kind: 'none' };
}

const unfinishedRunStatuses: ReadonlySet<WorkflowRunSummary['status']> = new Set([
  'preparing',
  'running',
  'waiting',
  'paused',
]);

/**
 * Names the workflow the delete cancels, or says plainly that Isagi can't tell yet. Nothing to
 * review once the surface is known to hold no unfinished run (it ended while the palette was
 * open), so the delete just runs.
 */
export function deleteSurfaceReview(
  ctx: PaletteContext,
  target: { readonly surfaceId: number } | null,
): ReviewContent | null {
  if (!target) {
    throw new Error(surfaceActionsCopy.deleteSurface.gone);
  }
  const workflow = workflowOn(ctx, target.surfaceId);
  if (workflow.kind === 'none') {
    return null;
  }
  if (workflow.kind === 'unknown') {
    const copy = surfaceActionsCopy.deleteSurface.unknownReview;
    return {
      title: copy.title,
      body: copy.body,
      items: [],
      choices: [
        { value: 'delete', label: copy.confirm, intent: 'danger' },
        { value: 'cancel', label: copy.cancel, intent: 'cancel' },
      ],
    };
  }
  const copy = surfaceActionsCopy.deleteSurface.review;
  return {
    title: copy.title,
    body: copy.body,
    items: [{ label: copy.workflowLabel, detail: workflow.run.title }],
    choices: [
      { value: 'delete', label: copy.confirm, intent: 'danger' },
      { value: 'cancel', label: copy.cancel, intent: 'cancel' },
    ],
  };
}

export const deleteActivePaneCommand: PaletteCommand = {
  id: 'delete-active-pane',
  label: 'Delete active pane',
  icon: Trash2,
  group: 'worktree-actions',
  available: (ctx) => Boolean(ctx.activeSurface),
  preflight: async (ctx, values) => {
    const target = activeSurfaceTargetFromValues(values, ctx);
    if (!target) {
      return { mode: 'unavailable' };
    }
    const detail = await fetchSurfaceDetail(ctx, target.surfaceId);
    const explicitPaneId = Number(values.paneId);
    const pane = Number.isInteger(explicitPaneId)
      ? (detail.panes.find((candidate) => candidate.id === explicitPaneId) ?? null)
      : resolveCommandPane(detail, ctx.activePaneId);
    if (!pane) {
      return { mode: 'unavailable' };
    }
    const nextValues = {
      surfaceId: String(target.surfaceId),
      worktreeId: String(target.worktreeId),
      paneId: String(pane.id),
    };
    return { mode: 'run', values: nextValues };
  },
  run: async (values, ctx) => {
    const target = activeSurfaceTargetFromValues(values, ctx);
    const paneId = Number(values.paneId);
    if (!target || !Number.isInteger(paneId)) {
      return;
    }
    await ctx.app(deleteSurfacePaneFromPalette({ ...target, paneId }));
  },
};

export const splitPaneRightCommand = splitPaneCommand({
  id: 'split-pane-right',
  label: 'Split pane right',
  direction: 'right',
  icon: PanelRight,
});

export const splitPaneDownCommand = splitPaneCommand({
  id: 'split-pane-down',
  label: 'Split pane down',
  direction: 'down',
  icon: PanelBottom,
});

/**
 * Switches the active agent pane between its terminal and the Fluidcast player. Offered only on a
 * surface that holds an agent pane. It never refuses silently: a non-agent pane is explained here,
 * and a switch Fluidcast cannot make (turned off, invalid config, unsupported harness, launch
 * blocked) reaches the runtime, whose reason becomes the palette's error. Only a terminal goes to
 * Fluidcast; a Fluidcast pane or a failed switch goes back to the terminal. The switch's `from` is
 * the preflight's fresh read, the same one that chose the direction, so a change while the request
 * waits is refused instead of acted on.
 */
export const togglePaneInteractionCommand: PaletteCommand = {
  id: 'toggle-pane-interaction',
  label: fluidcastCopy.paletteLabel,
  icon: Mic,
  group: 'worktree-actions',
  available: (ctx) => ctx.activeSurface?.paneKinds.includes('agent_session') === true,
  preflight: async (ctx, values) => {
    const target = activeSurfaceTargetFromValues(values, ctx);
    if (!target) {
      return { mode: 'unavailable' };
    }
    const detail = await fetchSurfaceDetail(ctx, target.surfaceId);
    const explicitPaneId = Number(values.paneId);
    const pane = Number.isInteger(explicitPaneId)
      ? (detail.panes.find((candidate) => candidate.id === explicitPaneId) ?? null)
      : resolveCommandPane(detail, ctx.activePaneId);
    if (pane?.session?.kind !== 'agent_session') {
      throw new UserVisibleError(fluidcastCopy.notAnAgentPane);
    }
    const { agentSession } = pane.session;
    return {
      mode: 'run',
      values: {
        surfaceId: String(target.surfaceId),
        worktreeId: String(target.worktreeId),
        paneId: String(pane.id),
        agentSessionId: String(agentSession.id),
        mode: agentSession.interaction.mode === 'terminal' ? 'fluidcast' : 'terminal',
      },
      payloads: { from: interactionOrigin(agentSession) },
    };
  },
  run: async (values, ctx, payloads) => {
    const target = activeSurfaceTargetFromValues(values, ctx);
    const paneId = Number(values.paneId);
    const agentSessionId = Number(values.agentSessionId);
    const mode = values.mode;
    const from = payloads?.from;
    if (
      !target ||
      !Number.isInteger(paneId) ||
      !Number.isInteger(agentSessionId) ||
      (mode !== 'terminal' && mode !== 'fluidcast') ||
      !isInteractionOrigin(from)
    ) {
      return;
    }
    await ctx.app(
      setPaneInteraction({ surfaceId: target.surfaceId, paneId, agentSessionId, mode, from }),
    );
  },
};

export const surfaceActionCommands: readonly PaletteCommand[] = [
  renameActiveSurfaceCommand,
  splitPaneRightCommand,
  splitPaneDownCommand,
  deleteActiveSurfaceCommand,
  deleteActivePaneCommand,
  togglePaneInteractionCommand,
];

function splitPaneCommand(input: {
  readonly id: string;
  readonly label: string;
  readonly direction: SplitPaneDirection;
  readonly icon: PaletteCommand['icon'];
}): PaletteCommand {
  return {
    id: input.id,
    label: input.label,
    icon: input.icon,
    group: 'worktree-actions',
    available: (ctx) => Boolean(ctx.activeSurface),
    preflight: async (ctx, values) => {
      const target = activeSurfaceTargetFromValues(values, ctx);
      if (!target) {
        return { mode: 'unavailable' };
      }
      const detail = await fetchSurfaceDetail(ctx, target.surfaceId);
      const explicitPaneId = Number(values.paneId);
      const pane = Number.isInteger(explicitPaneId)
        ? (detail.panes.find((candidate) => candidate.id === explicitPaneId) ?? null)
        : resolveCommandPane(detail, ctx.activePaneId);
      // This command duplicates the source pane's session kind, which only the
      // PTY-backed kinds have. An editor context is not duplicable that way, so
      // it is excluded here rather than falling through to the terminal branch.
      if (!pane?.session || pane.session.kind === 'editor_context') {
        return { mode: 'unavailable' };
      }
      const nextValues = {
        surfaceId: String(target.surfaceId),
        worktreeId: String(target.worktreeId),
        paneId: String(pane.id),
        sourceKind: pane.session.kind,
      };
      return pane.session.kind === 'agent_session'
        ? { mode: 'palette', values: nextValues }
        : { mode: 'run', values: nextValues };
    },
    args: [
      {
        ...harnessSelectArg,
        skip: (_ctx, values) => values.sourceKind !== 'agent_session',
      },
    ],
    run: async (values, ctx) => {
      const target = activeSurfaceTargetFromValues(values, ctx);
      const paneId = Number(values.paneId);
      if (!target || !Number.isInteger(paneId)) {
        return;
      }
      const sourceKind = values.sourceKind;
      if (sourceKind === 'agent_session') {
        const harness = parseAgentHarness(values.harness);
        if (harness === null) {
          throw new UserVisibleError(surfaceActionsCopy.chooseHarness);
        }
        await ctx.app(
          splitPaneFromPalette({
            ...target,
            split: {
              paneId,
              direction: input.direction,
              newPane: { kind: 'agent_session', harness },
            },
          }),
        );
        return;
      }
      if (sourceKind === 'terminal_session') {
        await ctx.app(
          splitPaneFromPalette({
            ...target,
            split: {
              paneId,
              direction: input.direction,
              newPane: { kind: 'terminal_session' },
            },
          }),
        );
      }
    },
  };
}

function activeSurfaceTarget(ctx: PaletteContext) {
  if (!ctx.activeWorktree || !ctx.activeSurface) {
    return null;
  }
  return { worktreeId: ctx.activeWorktree.id, surfaceId: ctx.activeSurface.id };
}

function activeSurfaceTargetFromValues(values: ArgValues, ctx: PaletteContext) {
  const surfaceId = Number(values.surfaceId);
  const worktreeId = Number(values.worktreeId);
  if (Number.isInteger(surfaceId) && Number.isInteger(worktreeId)) {
    return { worktreeId, surfaceId };
  }
  return activeSurfaceTarget(ctx);
}

function readSurfaceId(values: ArgValues, ctx: PaletteContext) {
  const surfaceId = Number(values.surfaceId);
  if (Number.isInteger(surfaceId)) {
    return surfaceId;
  }
  return ctx.activeSurface?.id ?? null;
}

/**
 * A fresh read of the surface, through its cached query so the result also refreshes the cache:
 * the decision is made on what the runtime says now, not on a possibly stale snapshot. One attempt,
 * as the old `fetchQuery({ staleTime: 0 })`: a preflight that cannot read reports at once.
 */
function fetchSurfaceDetail(ctx: PaletteContext, surfaceId: number): Promise<SurfaceDetail> {
  return ctx.app(readFresh(surfaceDetailAtom(surfaceId)));
}

function resolveCommandPane(
  detail: SurfaceDetail,
  activePaneId: number | null,
): SurfacePane | null {
  const paneId = resolveActivePaneId(detail.panes, activePaneId, detail.activePaneId);
  return detail.panes.find((pane) => pane.id === paneId) ?? null;
}
