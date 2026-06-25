import { motion } from 'motion/react';

import type { WorkflowSurfaceStatus } from '@isagi/contracts';

import { EASE_EXPO } from '../../lib/motion.js';

const glowClassByStatus: Record<WorkflowSurfaceStatus, string> = {
  driving:
    'border-working/20 shadow-[inset_0_0_42px_color-mix(in_srgb,var(--color-working)_17%,transparent),0_0_34px_color-mix(in_srgb,var(--color-working)_12%,transparent)] animate-[breathe_3.5s_var(--ease-expo)_infinite]',
  waiting_user:
    'border-waiting/24 shadow-[inset_0_0_46px_color-mix(in_srgb,var(--color-waiting)_18%,transparent),0_0_38px_color-mix(in_srgb,var(--color-waiting)_14%,transparent)] animate-glow',
  paused:
    'border-line/20 shadow-[inset_0_0_34px_color-mix(in_srgb,var(--color-fg-subtle)_9%,transparent)]',
  failed:
    'border-error/26 shadow-[inset_0_0_42px_color-mix(in_srgb,var(--color-error)_16%,transparent),0_0_30px_color-mix(in_srgb,var(--color-error)_10%,transparent)]',
  done: 'border-green/18 shadow-[inset_0_0_34px_color-mix(in_srgb,var(--color-green)_10%,transparent)]',
};

export function WorkflowSurfaceGlow({ status }: { readonly status: WorkflowSurfaceStatus | null }) {
  if (!status) return null;

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
        className={`h-full rounded-md border transition-[border-color,box-shadow,opacity] duration-surface ease-expo motion-reduce:animate-none ${glowClassByStatus[status]}`}
      />
    </motion.div>
  );
}
