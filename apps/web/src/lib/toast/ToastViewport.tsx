import { AnimatePresence, motion } from 'motion/react';

import { useToastStore } from './store.js';
import { ToastCard } from './ToastCard.js';

export function ToastViewport() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

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
