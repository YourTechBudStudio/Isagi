import { Maximize2, Minimize2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { surfaceTransition } from '../../lib/motion.js';
import { restoreActivePaneFocus } from '../../lib/workspace/activation.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import { CommandsView } from './WorkbenchCommands.js';

const MIN_WIDTH = 800;
const DEFAULT_WIDTH = `max(${MIN_WIDTH}px, 60vw)`;

/**
 * The workbench drawer — a dedicated monitor for the worktree's commands. Slides
 * in from the right at full height and hosts the commands master-detail view.
 * Commands are processes you *watch* (logs, ports, run/stop); interactive shells
 * live on the canvas as terminal surfaces, not here.
 */
export function WorkbenchDrawer() {
  const open = useWorkspaceStore((state) => state.drawer.open);
  const closeDrawer = useWorkspaceStore((state) => state.closeDrawer);

  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const closeDrawerAndRestoreFocus = useCallback(() => {
    closeDrawer();
    restoreActivePaneFocus();
  }, [closeDrawer]);

  // Dismiss on Escape or a click anywhere outside the drawer.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDrawerAndRestoreFocus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (asideRef.current && !asideRef.current.contains(event.target as Node)) {
        closeDrawerAndRestoreFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, closeDrawerAndRestoreFocus]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setExpanded(false);
    const startX = event.clientX;
    const startWidth =
      asideRef.current?.getBoundingClientRect().width ?? widthRef.current ?? MIN_WIDTH;
    // The only real bound is the work area; drag as broad as that.
    const maxWidth = asideRef.current?.parentElement?.clientWidth ?? startWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + (startX - moveEvent.clientX);
      setWidth(Math.max(MIN_WIDTH, Math.min(maxWidth, next)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="drawer"
          ref={asideRef}
          initial={{ x: '100%', opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '100%', opacity: 0 }}
          transition={surfaceTransition}
          style={{ width: expanded ? '100%' : (width ?? DEFAULT_WIDTH) }}
          className="absolute top-0 right-0 bottom-0 z-20 flex flex-col border-l border-line/24 bg-canvas/85 shadow-lift backdrop-blur-lg"
        >
          <div
            onPointerDown={startResize}
            className="group/grip absolute top-0 bottom-0 left-0 w-1.75 cursor-col-resize"
          >
            <span className="absolute top-[30%] bottom-[30%] left-0.5 w-0.5 rounded-full bg-transparent transition-colors group-hover/grip:bg-blue/45" />
          </div>

          <div className="flex h-11 flex-none items-center gap-2 border-b border-line/14 px-3.5">
            <span className="font-mono text-[12px] text-fg-muted">Commands</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                title={expanded ? 'Restore width' : 'Expand to full width'}
                className="grid size-7 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg"
              >
                {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                type="button"
                onClick={closeDrawerAndRestoreFocus}
                title="Close commands drawer"
                className="grid size-7 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            <CommandsView />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
