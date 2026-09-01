import { PanelBottom, PanelRight, Pencil, Trash2 } from 'lucide-react';

import type { SplitPaneDirection, SurfaceDetail, SurfacePane } from '@isagi/contracts';

import { surfaceActionsCopy } from '../../../copy/index.js';
import { parseAgentHarness } from '../../harness-labels.js';
import { queryClient } from '../../query/client.js';
import { runRuntimeEffect } from '../../runtime/run.js';
import { resolveActivePaneId } from '../../workspace/model.js';
import {
  deleteSurfaceFromPalette,
  deleteSurfacePaneFromPalette,
  renameSurfaceTitleFromPalette,
  splitPaneFromPalette,
} from '../../workspace/queries.js';
import { surfaceDetailQueryKey } from '../../workspace/query-keys.js';
import { getSurfaceDetail, UserVisibleError } from '../../workspace/runtime-data.js';
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
    await renameSurfaceTitleFromPalette(surfaceId, title);
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
    await deleteSurfaceFromPalette(target);
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
    const detail = await fetchSurfaceDetail(target.surfaceId);
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
    await deleteSurfacePaneFromPalette({ ...target, paneId });
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

export const surfaceActionCommands: readonly PaletteCommand[] = [
  renameActiveSurfaceCommand,
  splitPaneRightCommand,
  splitPaneDownCommand,
  deleteActiveSurfaceCommand,
  deleteActivePaneCommand,
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
      const detail = await fetchSurfaceDetail(target.surfaceId);
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
        await splitPaneFromPalette({
          ...target,
          split: {
            paneId,
            direction: input.direction,
            newPane: { kind: 'agent_session', harness },
          },
        });
        return;
      }
      if (sourceKind === 'terminal_session') {
        await splitPaneFromPalette({
          ...target,
          split: {
            paneId,
            direction: input.direction,
            newPane: { kind: 'terminal_session' },
          },
        });
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

async function fetchSurfaceDetail(surfaceId: number) {
  return queryClient.fetchQuery({
    queryKey: surfaceDetailQueryKey(surfaceId),
    queryFn: ({ signal }) => runRuntimeEffect(getSurfaceDetail(surfaceId), { signal }),
    staleTime: 0,
  });
}

function resolveCommandPane(
  detail: SurfaceDetail,
  activePaneId: number | null,
): SurfacePane | null {
  const paneId = resolveActivePaneId(detail.panes, activePaneId, detail.activePaneId);
  return detail.panes.find((pane) => pane.id === paneId) ?? null;
}
