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
import { usePaletteStore } from '../../lib/palette/store.js';
import {
  registerDrawerFocusTarget,
  restoreActivePaneFocus,
} from '../../lib/workspace/activation.js';
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

  // The drawer owns keyboard focus while it is the topmost open surface. One
  // effect covers both halves because the aside only exists while `open`:
  // focus-on-open (for pointer entry paths like the status strip, where no
  // focus router runs) and target registration (so the palette's close path can
  // route focus here when the drawer was already open and no open transition
  // fired). `preventScroll` keeps the slide-in from triggering a scroll jump.
  useEffect(() => {
    if (!open) {
      return;
    }
    const focusDrawer = () => asideRef.current?.focus({ preventScroll: true });
    focusDrawer();
    return registerDrawerFocusTarget(focusDrawer);
  }, [open]);

  // Dismiss on Escape or a click anywhere outside the drawer.
  //
  // Dismissal belongs to the topmost open surface. These are window-level
  // listeners on a surface that sits *beneath* the palette, so without the
  // guard any pointer selection in the palette would dismiss the drawer on
  // `pointerdown` (React's handlers run at the root before the event reaches
  // window), and an Escape the busy palette leaves unconsumed would dismiss it
  // mid-run. Palette state is read via `getState()` at event time rather than
  // subscribed: during the very click that closes the palette, this listener
  // fires after React's handlers but before the close effect commits
  // `closePalette()`, so `open` still reads true and the drawer correctly
  // ignores that click. The next outside click dismisses it normally. When the
  // palette is closed both handlers behave exactly as they did before.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (usePaletteStore.getState().open) {
        return;
      }
      if (event.key === 'Escape') {
        closeDrawerAndRestoreFocus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (usePaletteStore.getState().open) {
        return;
      }
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
          // The aside is the stable focus target: a landmark that exists in
          // every catalog state, unlike the inner controls (a command detail
          // only exists when a command is selected, and diagnostics replace
          // it). Screen readers announce the handoff as focus landing on the
          // "Commands" complementary region. Tab from here reaches the header
          // controls, then the command list, in existing DOM order — no
          // tab-index surgery on inner controls.
          tabIndex={-1}
          aria-labelledby="workbench-drawer-title"
          initial={{ x: '100%', opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '100%', opacity: 0 }}
          transition={surfaceTransition}
          style={{ width: expanded ? '100%' : (width ?? DEFAULT_WIDTH) }}
          // `outline-none` is paired with a focus-visible ring, never left
          // bare: a keyboard handoff has to be visible. Pointer interaction
          // inside the drawer shows nothing.
          className="absolute top-0 right-0 bottom-0 z-20 flex flex-col border-l border-line/24 bg-canvas/85 shadow-lift outline-none backdrop-blur-lg focus-visible:ring-1 focus-visible:ring-blue/40 focus-visible:ring-inset"
        >
          <div
            onPointerDown={startResize}
            className="group/grip absolute top-0 bottom-0 left-0 w-1.75 cursor-col-resize"
          >
            <span className="absolute top-[30%] bottom-[30%] left-0.5 w-0.5 rounded-full bg-transparent transition-colors group-hover/grip:bg-blue/45" />
          </div>

          <div className="flex h-11 flex-none items-center gap-2 border-b border-line/14 px-3.5">
            <span id="workbench-drawer-title" className="font-mono text-[12px] text-fg-muted">
              Commands
            </span>
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
