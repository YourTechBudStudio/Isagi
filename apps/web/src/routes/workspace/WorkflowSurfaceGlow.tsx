import { motion } from 'motion/react';

import { EASE_EXPO } from '../../lib/motion.js';
import type { WorkflowTone } from '../../lib/workspace/workflow/derive.js';

const glowClassByTone: Record<WorkflowTone, string> = {
  working:
    'border-working/20 shadow-[inset_0_0_42px_color-mix(in_srgb,var(--color-working)_17%,transparent),0_0_34px_color-mix(in_srgb,var(--color-working)_12%,transparent)] animate-[breathe_3.5s_var(--ease-expo)_infinite]',
  waiting:
    'border-waiting/24 shadow-[inset_0_0_46px_color-mix(in_srgb,var(--color-waiting)_18%,transparent),0_0_38px_color-mix(in_srgb,var(--color-waiting)_14%,transparent)] animate-glow',
  // Paused and cancelled runs settle rather than reading as success.
  idle: 'border-line/20 shadow-[inset_0_0_34px_color-mix(in_srgb,var(--color-fg-subtle)_9%,transparent)]',
  error:
    'border-error/26 shadow-[inset_0_0_42px_color-mix(in_srgb,var(--color-error)_16%,transparent),0_0_30px_color-mix(in_srgb,var(--color-error)_10%,transparent)]',
  success:
    'border-green/18 shadow-[inset_0_0_34px_color-mix(in_srgb,var(--color-green)_10%,transparent)]',
};

export function WorkflowSurfaceGlow({ tone }: { readonly tone: WorkflowTone | null }) {
  if (!tone) return null;

  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 rounded-md p-1"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.42, ease: EASE_EXPO }}
    >
      <div
        className={`h-full rounded-md border transition-[border-color,box-shadow,opacity] duration-surface ease-expo motion-reduce:animate-none ${glowClassByTone[tone]}`}
      />
    </motion.div>
  );
}
