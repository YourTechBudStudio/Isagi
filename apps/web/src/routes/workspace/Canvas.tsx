import { Plus } from 'lucide-react';

import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { canvasCopy } from '../../copy/index.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import { modKey } from '../../lib/platform.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import { surfaceIcon } from '../../lib/workspace/surface-presentation.js';
import type { Surface, Worktree } from '../../lib/workspace/types.js';
import { AgentSurface } from './AgentSurface.js';
import { MissingProjectState } from './MissingProjectState.js';
import { TerminalSurface } from './TerminalSurface.js';

/**
 * The canvas — the hero. Renders the active worktree's active surface, or a calm
 * empty state when there's nothing to show. Navigation lives in the rail, so
 * the canvas carries no tab chrome.
 */
export function Canvas() {
  const { activeWorktree, activeMissingProject, activeSurface } = useWorkspace();
  if (activeMissingProject) {
    return <MissingProjectState project={activeMissingProject} />;
  }

  if (!activeWorktree) {
    return <FreshEmptyState />;
  }

  if (!activeSurface) {
    return <NoSurfaceState worktree={activeWorktree} />;
  }

  if (activeSurface.kind === 'agent') {
    return <AgentSurface key={activeSurface.id} surface={activeSurface} />;
  }

  if (activeSurface.kind === 'terminal') {
    return <TerminalSurface key={activeSurface.id} surface={activeSurface} />;
  }

  return <SurfacePlaceholder surface={activeSurface} />;
}

function SurfacePlaceholder({ surface }: { surface: Surface }) {
  const Icon = surfaceIcon(surface.kind);
  const setZen = useWorkspaceStore((state) => state.setZen);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-line/20 bg-elevated/50 backdrop-blur-sm">
      <div className="flex items-center gap-2.5 border-b border-line/15 px-3.5 py-2.5">
        <Icon size={14} className="text-fg-subtle" />
        <span className="font-mono text-[12px] text-fg-muted">
          {surface.source ?? surface.title}
        </span>
        <span className="ml-auto flex gap-2 font-mono text-[11px] text-fg-subtle">
          <span className="cursor-default rounded-md border border-line/28 px-2 py-1">
            ⤤ pop out
          </span>
          <button
            type="button"
            onClick={() => setZen(true)}
            className="rounded-md border border-line/28 px-2 py-1 transition-colors hover:border-blue/45 hover:text-fg"
          >
            ⤢ zen
          </button>
        </span>
      </div>
      <div className="grid flex-1 place-items-center">
        <span className="font-mono text-[12px] text-fg-subtle opacity-55">
          {canvasCopy.surfacePlaceholder(surface)}
        </span>
      </div>
    </div>
  );
}

function FreshEmptyState() {
  const openPalette = usePaletteStore((state) => state.openPalette);

  return (
    <EmptyState
      title={canvasCopy.freshEmpty.title}
      body={canvasCopy.freshEmpty.body}
      actions={
        <Button icon={Plus} shortcut={`${modKey}N`} onClick={() => openPalette('add-project')}>
          Add project
        </Button>
      }
      aside={canvasCopy.freshEmpty.aside}
    />
  );
}

function NoSurfaceState({ worktree }: { worktree: Worktree }) {
  return (
    <EmptyState
      title={canvasCopy.noSurface.title}
      body={canvasCopy.noSurface.body(worktree)}
      aside={canvasCopy.noSurface.aside}
    />
  );
}
