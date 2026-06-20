import { Plus } from 'lucide-react';

import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { canvasCopy } from '../../copy/index.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import { modKey } from '../../lib/platform.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import type { Worktree } from '../../lib/workspace/types.js';
import { MissingProjectState } from './MissingProjectState.js';
import { Surface } from './Surface.js';

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

  return <Surface key={activeSurface.id} surface={activeSurface} />;
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
