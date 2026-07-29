import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { Ref } from 'react';

import { ptyCopy } from '../../../copy/index.js';
import { terminalRevealTransition } from './revealMotion.js';
import { TerminalLoadingCover } from './TerminalLoadingCover.js';

/**
 * The pane-side window onto a cached terminal.
 *
 * The slot is a positioned container holding two things: a host element the
 * terminal cache parks its xterm DOM node into, and — until the controller says
 * the terminal has actually painted — an opaque cover over it. React owns the
 * slot; it never owns what lives inside the host.
 *
 * `revealed` is the caller's single input. Phase 05 derives it from a real
 * xterm `onRender`, not from `replay_end` or a frame tick; here it is just a
 * boolean, and the component deliberately knows nothing about replay, sockets,
 * or cache lifecycle.
 *
 * While covered the host is `inert` and at zero opacity, so history is hidden
 * twice over: assistive technology cannot read it, focus cannot enter it, and
 * a mispainted frame cannot flash through.
 */
export function TerminalRevealSlot({
  revealed,
  hostRef,
  className = 'min-h-0 flex-1',
}: {
  readonly revealed: boolean;
  readonly hostRef?: Ref<HTMLDivElement> | undefined;
  readonly className?: string | undefined;
}) {
  const reduced = useReducedMotion() ?? false;

  return (
    <div className={`relative isolate overflow-hidden bg-terminal-surface ${className}`}>
      {/*
        One stable live region for the whole slot. Announcing from inside the
        cover would depend on the AT noticing a live region at insertion time;
        a region that is always mounted and whose content changes announces
        reliably, exactly once, and goes quiet on reveal.
      */}
      <span role="status" className="sr-only">
        {revealed ? '' : ptyCopy.reconstructing}
      </span>
      <div
        ref={hostRef}
        data-terminal-host
        inert={!revealed}
        className={`isagi-xterm isagi-xterm-edge h-full w-full ${revealed ? '' : 'opacity-0'}`}
      />
      <AnimatePresence initial={false}>
        {revealed ? null : (
          <motion.div
            key="cover"
            className="absolute inset-0"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={terminalRevealTransition(reduced)}
          >
            <TerminalLoadingCover reducedMotion={reduced} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
