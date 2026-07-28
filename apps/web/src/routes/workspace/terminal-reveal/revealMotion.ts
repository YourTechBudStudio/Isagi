import type { Transition } from 'motion/react';

import { uiTransition } from '../../../lib/motion.js';

/**
 * The reveal is opacity only — a terminal that slides or scales on arrival
 * would read as a new panel rather than the one the user left. Reduced motion
 * cuts straight to revealed; there is no spatial fallback to degrade to.
 */
export function terminalRevealTransition(reducedMotion: boolean): Transition {
  return reducedMotion ? { duration: 0 } : uiTransition;
}
