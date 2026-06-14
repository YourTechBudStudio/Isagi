import { useCallback, useMemo } from 'react';

import { toastCopy } from '../../copy/index.js';
import { queryClient } from '../query/client.js';
import { showToast } from '../toast/index.js';
import { useWorkspace } from '../workspace/hooks.js';
import { formatRuntimeError, workspaceQueryKey } from '../workspace/queries.js';
import { useWorkspaceStore } from '../workspace/store.js';
import { surfaceActionCommands } from './commands/surface-actions.js';
import { buildPaletteContext } from './context.js';
import { assembleEntries } from './entries.js';
import { usePaletteStore } from './store.js';
import type {
  ArgValues,
  CommandPreflightResult,
  PaletteCommand,
  PaletteContext,
  PaletteEntry,
} from './types.js';

export interface DispatchCommandOptions {
  readonly entries?: readonly PaletteEntry[];
  readonly ctx?: PaletteContext;
  readonly openPalette?: (entryId?: string, values?: ArgValues) => void;
  readonly pushRecent?: (entryId: string) => void;
}

export async function dispatchCommandEntry(
  entryId: string,
  values: ArgValues = {},
  options: DispatchCommandOptions,
): Promise<void> {
  const entries = options.entries ?? [];
  const entry =
    entries.find((candidate) => candidate.id === entryId) ?? explicitDispatchEntry(entryId, values);
  if (!entry || !options.ctx) {
    return;
  }

  if (!entry.command) {
    await entry.run();
    options.pushRecent?.(entry.id);
    return;
  }

  if (entry.command.feedbackSurface === 'palette' && options.openPalette) {
    options.openPalette(entry.id, values);
    return;
  }

  const preflight = await resolveCommandPreflight(entry.command, options.ctx, values);

  if (preflight.mode === 'unavailable') {
    return;
  }

  if (preflight.mode === 'palette') {
    options.openPalette?.(entry.id, preflight.values ?? values);
    return;
  }

  await entry.command.run(preflight.values ?? values, options.ctx, preflight.payloads);
  options.pushRecent?.(entry.id);
}

function explicitDispatchEntry(entryId: string, values: ArgValues): PaletteEntry | null {
  if (Object.keys(values).length === 0) {
    return null;
  }

  const command = surfaceActionCommands.find((candidate) => candidate.id === entryId);
  if (!command) {
    return null;
  }

  return {
    id: command.id,
    label: command.label,
    icon: command.icon,
    group: command.group,
    command,
    run: () => command.run(values, emptyPaletteContext),
  };
}

const emptyPaletteContext: PaletteContext = {
  projects: [],
  activeProject: null,
  activeWorktree: null,
  activeSurface: null,
  activePaneId: null,
};

export async function resolveCommandPreflight(
  command: PaletteCommand,
  ctx: PaletteContext,
  values: ArgValues = {},
): Promise<CommandPreflightResult> {
  return (
    (await command.preflight?.(ctx, values)) ??
    (command.args?.length ? { mode: 'palette', values } : { mode: 'run' })
  );
}

export function useCommandDispatcher() {
  const { projects, activeWorktreeId, activeSurfaceByWorktreeId } = useWorkspace();
  const activePaneBySurfaceId = useWorkspaceStore((state) => state.activePaneBySurfaceId);
  const openPalette = usePaletteStore((state) => state.openPalette);
  const pushRecent = usePaletteStore((state) => state.pushRecent);
  const ctx = useMemo(
    () =>
      buildPaletteContext(projects, activeWorktreeId, {
        activeSurfaceByWorktreeId,
        activePaneBySurfaceId,
      }),
    [projects, activeWorktreeId, activeSurfaceByWorktreeId, activePaneBySurfaceId],
  );
  const entries = useMemo(() => assembleEntries(ctx), [ctx]);

  return useCallback(
    (entryId: string, values: ArgValues = {}) =>
      dispatchCommandEntry(entryId, values, { entries, ctx, openPalette, pushRecent }),
    [ctx, entries, openPalette, pushRecent],
  );
}

export function handleDispatchedCommandError(error: unknown) {
  void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
  showToast({
    kind: 'warning',
    title: toastCopy.workbenchCommandFailed.title,
    subtitle: formatRuntimeError(error),
  });
  console.error('[palette] dispatched command failed', error);
}
