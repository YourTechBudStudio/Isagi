import { useCallback, useMemo } from 'react';

import { toastCopy } from '../../copy/index.js';
import { useEditorAvailable, useLaunchableHarnesses } from '../control-plane/queries.js';
import { queryClient } from '../query/client.js';
import { showToast } from '../toast/index.js';
import { useWorkspace } from '../workspace/hooks.js';
import { formatRuntimeError } from '../workspace/queries.js';
import { workspaceQueryKey } from '../workspace/query-keys.js';
import { useWorkspaceStore } from '../workspace/store.js';
import { workbenchActionCommands } from './commands/workbench-actions.js';
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

  const commandValues = { ...(entry.values ?? {}), ...values };
  if (!entry.command) {
    await entry.run();
    options.pushRecent?.(entry.id);
    return;
  }

  if (entry.command.feedbackSurface === 'palette' && options.openPalette) {
    options.openPalette(entry.id, commandValues);
    return;
  }

  const preflight = await resolveCommandPreflight(entry.command, options.ctx, commandValues);

  if (preflight.mode === 'unavailable') {
    return;
  }

  if (preflight.mode === 'palette') {
    options.openPalette?.(entry.id, preflight.values ?? commandValues);
    return;
  }

  await entry.command.run(preflight.values ?? commandValues, options.ctx, preflight.payloads);
  options.pushRecent?.(entry.id);
}

function explicitDispatchEntry(entryId: string, values: ArgValues): PaletteEntry | null {
  if (Object.keys(values).length === 0) {
    return null;
  }

  const command = workbenchActionCommands.find((candidate) => candidate.id === entryId);
  if (!command) {
    return null;
  }

  return {
    id: command.id,
    label: command.label,
    icon: command.icon,
    group: command.group,
    command,
    values,
    run: () => command.run(values, emptyPaletteContext),
  };
}

const emptyPaletteContext: PaletteContext = {
  projects: [],
  activeProject: null,
  activeWorktree: null,
  activeSurface: null,
  activePaneId: null,
  launchableHarnesses: [],
  // An explicit chrome dispatch names its own target and never asks about
  // availability; this fallback context exists only to satisfy `run`.
  editorAvailable: false,
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
  const launchableHarnesses = useLaunchableHarnesses();
  const editorAvailable = useEditorAvailable();
  const openPalette = usePaletteStore((state) => state.openPalette);
  const pushRecent = usePaletteStore((state) => state.pushRecent);
  const ctx = useMemo(
    () =>
      buildPaletteContext(projects, activeWorktreeId, {
        launchableHarnesses,
        editorAvailable,
        activeSurfaceByWorktreeId,
        activePaneBySurfaceId,
      }),
    [
      projects,
      activeWorktreeId,
      launchableHarnesses,
      editorAvailable,
      activeSurfaceByWorktreeId,
      activePaneBySurfaceId,
    ],
  );
  const entries = useMemo(() => assembleEntries(ctx), [ctx]);

  return useCallback(
    (entryId: string, values: ArgValues = {}) =>
      dispatchCommandEntry(entryId, values, { entries, ctx, openPalette, pushRecent }),
    [ctx, entries, openPalette, pushRecent],
  );
}

/**
 * Refreshes workspace state after a failed dispatch and reports the failure.
 *
 * Pass `toast: false` when the action surface that started the command is still
 * on screen and is showing the failure itself — the refresh and the log line are
 * still wanted, a second copy of the message in unrelated chrome is not (ADR
 * 0004).
 */
export function handleDispatchedCommandError(
  error: unknown,
  options: { readonly toast?: boolean } = {},
) {
  void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
  if (options.toast ?? true) {
    showToast({
      kind: 'warning',
      title: toastCopy.workbenchCommandFailed.title,
      subtitle: formatRuntimeError(error),
    });
  }
  console.error('[palette] dispatched command failed', error);
}
