import { useAtomValue } from '@effect/atom-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback } from 'react';

import { useRegistry } from '../state/registry.js';
import { dismissToast, toastsAtom } from './store.js';
import { ToastCard } from './ToastCard.js';

export function ToastViewport() {
  const registry = useRegistry();
  const toasts = useAtomValue(toastsAtom);
  // Stable per registry: `ToastCard` restarts its auto-dismiss timer when this identity changes.
  const dismiss = useCallback((id: string) => dismissToast(registry, id), [registry]);

  return (
    <motion.div
      aria-live="polite"
      aria-relevant="additions removals"
      className="pointer-events-none fixed top-4 right-4 z-45 flex flex-col items-end gap-2.5"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <ToastCard toast={toast} onDismiss={dismiss} />
          </div>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}
