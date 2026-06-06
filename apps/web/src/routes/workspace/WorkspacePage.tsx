import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';

import { TooltipDelayProvider } from '../../components/Tooltip.js';
import { EASE_EXPO, DURATION } from '../../lib/motion.js';
import { usePaletteStore } from '../../lib/palette/store.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
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
export function WorkspacePage() {
  const zen = useWorkspaceStore((state) => state.zen);
  const setZen = useWorkspaceStore((state) => state.setZen);
  const loadWorkspace = useWorkspaceStore((state) => state.loadWorkspace);
  const hasConfiguredProjects = useWorkspaceStore((state) => state.projects.length > 0);
  const paletteOpen = usePaletteStore((state) => state.open);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

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
      if ((event.metaKey || event.ctrlKey) && event.key === '.') {
        event.preventDefault();
        setZen(!zen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zen, paletteOpen, setZen]);

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
            {hasConfiguredProjects && <Rail />}
            <WorkArea />
          </div>
          <CommandPalette />
        </>
      </TooltipDelayProvider>
    </MotionConfig>
  );
}
