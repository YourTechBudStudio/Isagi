import { motion } from 'motion/react';
import { useEffect, useState } from 'react';

import { uiTransition, zenTransition } from '../../lib/motion.js';
import { useWorkspace } from '../../lib/workspace/hooks.js';
import { useWorkspaceStore } from '../../lib/workspace/store.js';
import { ActionBar } from './ActionBar.js';
import { Canvas } from './Canvas.js';
import { StatusStrip } from './StatusStrip.js';
import { WorkbenchDrawer } from './WorkbenchDrawer.js';

/**
 * The work area — everything right of the Rail: the canvas (hero), the always-on
 * status strip, the floating action bar, and the on-demand workbench drawer.
 *
 * Zen mode shares one `layoutId` between the in-slot canvas and a fixed
 * fullscreen canvas, so toggling zen makes the canvas **expand out of its slot
 * to fill the window and collapse back into it** on exit. The fullscreen layer
 * (z-40, opaque atmosphere) covers all chrome; `⌘K` still navigates, Esc exits.
 */
export function WorkArea() {
  const zen = useWorkspaceStore((state) => state.zen);
  const { error } = useWorkspace();

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {!zen && (
        <motion.div layoutId="zen-canvas" transition={zenTransition} className="min-h-0 flex-1 p-3">
          <Canvas />
        </motion.div>
      )}

      {error && !zen && <RuntimeErrorBanner error={error} />}
      <ActionBar />
      <StatusStrip />
      <WorkbenchDrawer />

      {zen && (
        <motion.div
          layoutId="zen-canvas"
          transition={zenTransition}
          className="canvas-atmosphere fixed inset-0 z-40 p-3"
        >
          <Canvas />
          <ZenExitHint />
        </motion.div>
      )}
    </div>
  );
}

function RuntimeErrorBanner({ error }: { error: string }) {
  return (
    <div className="pointer-events-none absolute top-3 left-1/2 z-20 max-w-[min(42rem,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-error/28 bg-canvas/88 px-3.5 py-2 font-mono text-[11.5px] text-error shadow-soft backdrop-blur-md">
      runtime refresh failed · {error}
    </div>
  );
}

function ZenExitHint() {
  const [show, setShow] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setShow(false), 2400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: show ? 1 : 0 }}
      transition={uiTransition}
      className="pointer-events-none absolute top-3 right-4 rounded-md border border-line/24 bg-elevated/70 px-3 py-1.5 font-mono text-[11px] text-fg-subtle backdrop-blur-md"
    >
      exit · esc
    </motion.span>
  );
}
