import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';

import { EmptyState } from '../../components/EmptyState.js';
import { TooltipDelayProvider } from '../../components/Tooltip.js';
import { workspaceBootCopy } from '../../copy/index.js';
import { useClientSettingsQuery } from '../../lib/client-settings/queries.js';
import { EASE_EXPO, DURATION } from '../../lib/motion.js';
import {
  handleDispatchedCommandError,
  useCommandDispatcher,
} from '../../lib/palette/dispatcher.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import { isPlatformModifierShortcut } from '../../lib/platform.js';
import {
  useWorkspace,
  usePersistActiveContextSelection,
  useWorkspaceSelectionSync,
} from '../../lib/workspace/hooks.js';
import { paneDeleteKey, useRunDelete } from '../../lib/workspace/pending-deletes.js';
import { formatRuntimeError, useWorkspaceQuery } from '../../lib/workspace/queries.js';
import { useRuntimeEventSubscription } from '../../lib/workspace/runtime-events.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import { TerminalPresentationProvider } from '../../lib/workspace/terminal-presentation/TerminalPresentationProvider.js';
import { CommandPalette } from './CommandPalette.js';
import { Rail } from './Rail.js';
import { WorkArea } from './WorkArea.js';

function FirstRunDragRegion() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 top-0 z-10 h-(--isagi-rail-top-inset,2.5rem) [-webkit-app-region:drag]"
    />
  );
}

/**
 * The workspace shell — Isagi's single primary surface.
 *
 * Layout (the "rail-spine" composition): once at least one project is
 * configured, the Rail is a continuous full-height navigation spine on the
 * left; the work area fills the rest. Before then, the work area owns the full
 * window so the first-run empty state is visually centered.
 */
function WorkspaceBootSurface() {
  return (
    <main className="canvas-atmosphere grid h-screen place-items-center p-6">
      <EmptyState
        title={workspaceBootCopy.restoring.title}
        body={workspaceBootCopy.restoring.body}
        aside={workspaceBootCopy.restoring.aside}
      />
    </main>
  );
}

function WorkspaceRuntimeError({ error }: { error: string }) {
  return (
    <main className="canvas-atmosphere grid h-screen place-items-center p-6">
      <EmptyState
        halo="error"
        title={workspaceBootCopy.runtimeConnectionFailed.title}
        body={workspaceBootCopy.runtimeConnectionFailed.body}
      >
        <p className="mt-0.5 max-w-full rounded-sm border border-error/24 bg-error/8 px-3 py-2 font-mono text-[12px] text-error">
          {error}
        </p>
      </EmptyState>
    </main>
  );
}

export function WorkspacePage() {
  const zen = useWorkspaceStore((state) => state.zen);
  const setZen = useWorkspaceStore((state) => state.setZen);
  const workspace = useWorkspaceQuery();
  const clientSettings = useClientSettingsQuery();
  const { activeSurface, activeWorktreeId } = useWorkspace();
  const dispatchCommand = useCommandDispatcher();
  const activePaneBySurfaceId = useWorkspaceStore((state) => state.activePaneBySurfaceId);
  const runDelete = useRunDelete();
  const workspaceErrorIsFatal = Boolean(workspace.error && !workspace.data);
  const settingsErrorIsFatal = Boolean(clientSettings.error && !clientSettings.data);
  const hasConfiguredProjects =
    !workspaceErrorIsFatal && (workspace.data?.projects.length ?? 0) > 0;
  const paletteOpen = usePaletteStore((state) => state.open);

  useWorkspaceSelectionSync();
  usePersistActiveContextSelection();
  useRuntimeEventSubscription();

  // Ask the optional host shell to quiet native chrome in zen. Browser-hosted
  // web builds simply do not provide this bridge.
  useEffect(() => {
    void window.isagi?.setHostChromeVisible?.(!zen);
  }, [zen]);

  // Zen: Esc exits (unless the palette owns Esc); a provisional Mod+. toggles it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && zen && !paletteOpen) {
        event.preventDefault();
        setZen(false);
        return;
      }
      if (isPlatformModifierShortcut(event) && event.key === '.') {
        event.preventDefault();
        setZen(!zen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zen, paletteOpen, setZen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        paletteOpen ||
        isEditableEventTarget(event.target) ||
        !isPlatformModifierShortcut(event) ||
        event.key.toLowerCase() !== 'w' ||
        !activeSurface
      ) {
        return;
      }

      event.preventDefault();

      // The shortcut has no affordance of its own, so it reports through the
      // target pane's action cluster, which pins visible while a delete runs.
      // That needs the pane id up front; when nothing is stored the command
      // still resolves its own target, it just runs without the local indicator.
      const activePaneId = activePaneBySurfaceId[activeSurface.id];
      if (activePaneId === undefined || activeWorktreeId === null) {
        void dispatchCommand('delete-active-pane').catch(handleDispatchedCommandError);
        return;
      }
      runDelete({
        key: paneDeleteKey(activePaneId),
        origin: 'pane',
        commandId: 'delete-active-pane',
        surfaceId: activeSurface.id,
        values: {
          worktreeId: String(activeWorktreeId),
          surfaceId: String(activeSurface.id),
          paneId: String(activePaneId),
        },
      });
    };

    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [
    activePaneBySurfaceId,
    activeSurface,
    activeWorktreeId,
    dispatchCommand,
    paletteOpen,
    runDelete,
  ]);

  return (
    <MotionConfig reducedMotion="user" transition={{ duration: DURATION.ui, ease: EASE_EXPO }}>
      <TooltipDelayProvider>
        <>
          <div
            className={`relative z-1 grid h-screen ${
              hasConfiguredProjects ? 'grid-cols-[236px_1fr]' : 'grid-cols-1'
            }`}
          >
            {!hasConfiguredProjects && <FirstRunDragRegion />}
            {(workspace.isPending && !workspace.data) ||
            (clientSettings.isPending && !clientSettings.data) ? (
              <WorkspaceBootSurface />
            ) : workspaceErrorIsFatal || settingsErrorIsFatal ? (
              <WorkspaceRuntimeError
                error={formatRuntimeError(workspace.error ?? clientSettings.error)}
              />
            ) : !clientSettings.data ? (
              <WorkspaceBootSurface />
            ) : (
              <TerminalPresentationProvider settings={clientSettings.data.terminal}>
                {hasConfiguredProjects && <Rail />}
                <WorkArea />
              </TerminalPresentationProvider>
            )}
          </div>
          <CommandPalette />
        </>
      </TooltipDelayProvider>
    </MotionConfig>
  );
}

function isEditableEventTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    target.isContentEditable ||
    Boolean(target.closest('[contenteditable="true"]'))
  );
}
