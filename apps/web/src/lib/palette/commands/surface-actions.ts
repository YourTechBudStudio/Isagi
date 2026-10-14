import { Mic, PanelBottom, PanelRight, Pencil, Trash2 } from 'lucide-react';

import type { SplitPaneDirection, SurfaceDetail, SurfacePane } from '@isagi/contracts';

import { fluidcastCopy, surfaceActionsCopy } from '../../../copy/index.js';
import { setPaneInteraction } from '../../fluidcast/commits.js';
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
import type { ArgValues, PaletteCommand, PaletteContext } from '../types.js';
import { harnessSelectArg } from './session-actions.js';

const TITLE_MAX_LENGTH = 80;

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

export const deleteActiveSurfaceCommand: PaletteCommand = {
  id: 'delete-active-surface',
  label: 'Delete active surface',
  icon: Trash2,
  group: 'worktree-actions',
  available: (ctx) => Boolean(ctx.activeSurface),
  preflight: (ctx, values) => {
    const target = activeSurfaceTargetFromValues(values, ctx);
    if (!target) {
      return { mode: 'unavailable' };
    }
    return {
      mode: 'run',
      values: {
        surfaceId: String(target.surfaceId),
        worktreeId: String(target.worktreeId),
      },
    };
  },
  run: async (values, ctx) => {
    const target = activeSurfaceTargetFromValues(values, ctx);
    if (!target) {
      return;
    }
    await ctx.app(deleteSurfaceFromPalette(target));
  },
};

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
 * blocked) reaches the runtime, whose reason becomes the palette's error.
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
        mode: agentSession.interaction.mode === 'fluidcast' ? 'terminal' : 'fluidcast',
      },
    };
  },
  run: async (values, ctx) => {
    const target = activeSurfaceTargetFromValues(values, ctx);
    const paneId = Number(values.paneId);
    const agentSessionId = Number(values.agentSessionId);
    const mode = values.mode;
    if (
      !target ||
      !Number.isInteger(paneId) ||
      !Number.isInteger(agentSessionId) ||
      (mode !== 'terminal' && mode !== 'fluidcast')
    ) {
      return;
    }
    await ctx.app(
      setPaneInteraction({ surfaceId: target.surfaceId, paneId, agentSessionId, mode }),
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
