import { AlertTriangle, CheckCircle, Info, X, XCircle, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useRef } from 'react';

import { surfaceTransition } from '../motion.js';
import { DEFAULT_TOAST_DURATION_MS } from './constants.js';
import type { Toast, ToastKind } from './types.js';

const KIND_TONE: Record<ToastKind, string> = {
  info: 'border-blue/24 bg-blue/10 text-blue',
  success: 'border-green/24 bg-green/10 text-green',
  warning: 'border-amber/28 bg-amber/10 text-amber',
  error: 'border-error/28 bg-error/10 text-error',
};

const KIND_ICON: Record<ToastKind, LucideIcon> = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: XCircle,
};

export function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const timeoutRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const remainingMsRef = useRef(autoDismissDuration(toast));
  const Icon = KIND_ICON[toast.kind];

  const clearDismissTimer = useCallback(() => {
    if (timeoutRef.current === null) {
      return;
    }
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const pauseDismissTimer = useCallback(() => {
    if (
      !toast.lifetime.autoDismiss ||
      timeoutRef.current === null ||
      startedAtRef.current === null
    ) {
      return;
    }
    remainingMsRef.current = Math.max(
      0,
      remainingMsRef.current - (Date.now() - startedAtRef.current),
    );
    clearDismissTimer();
  }, [clearDismissTimer, toast.lifetime]);

  const startDismissTimer = useCallback(() => {
    if (!toast.lifetime.autoDismiss || timeoutRef.current !== null) {
      return;
    }
    startedAtRef.current = Date.now();
    timeoutRef.current = window.setTimeout(() => onDismiss(toast.id), remainingMsRef.current);
  }, [onDismiss, toast.id, toast.lifetime]);

  useEffect(() => {
    remainingMsRef.current = autoDismissDuration(toast);
    startDismissTimer();
    return clearDismissTimer;
  }, [clearDismissTimer, startDismissTimer, toast]);

  return (
    <motion.article
      layout
      role={toast.kind === 'error' ? 'alert' : 'status'}
      initial={{ opacity: 0, y: -8, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -5, scale: 0.985 }}
      transition={surfaceTransition}
      onMouseEnter={pauseDismissTimer}
      onMouseLeave={startDismissTimer}
      onFocus={pauseDismissTimer}
      onBlur={startDismissTimer}
      className="grid w-[min(26rem,calc(100vw-2rem))] origin-top-right grid-cols-[1.75rem_minmax(0,1fr)_1.5rem] items-start gap-3 rounded-md border border-line/24 bg-overlay/88 p-3.5 text-left shadow-lift backdrop-blur-md"
    >
      <span className={`grid size-7 place-items-center rounded-sm border ${KIND_TONE[toast.kind]}`}>
        <Icon size={15} strokeWidth={1.8} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] leading-snug font-medium text-fg">{toast.title}</span>
        {toast.subtitle && (
          <span className="mt-1 block truncate font-mono text-[11px] text-fg-subtle">
            {toast.subtitle}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="grid size-6 place-items-center rounded-sm border border-line/24 text-fg-subtle transition-colors duration-micro ease-expo hover:border-line/55 hover:text-fg"
        aria-label="Dismiss notification"
      >
        <X size={13} strokeWidth={1.8} />
      </button>
    </motion.article>
  );
}

function autoDismissDuration(toast: Toast): number {
  return toast.lifetime.autoDismiss ? (toast.lifetime.durationMs ?? DEFAULT_TOAST_DURATION_MS) : 0;
}
