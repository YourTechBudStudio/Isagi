import { useCallback, useMemo } from 'react';

import { useWorkspace } from '../workspace/hooks.js';
import { useWorkspaceStore } from '../workspace/store.js';
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
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (!entry || !options.ctx) {
    return;
  }

  if (!entry.command) {
    await entry.run();
    options.pushRecent?.(entry.id);
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
