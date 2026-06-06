import { create } from 'zustand';

import { DEFAULT_TOAST_DURATION_MS, MAX_VISIBLE_TOASTS } from './constants.js';
import type { Toast, ToastInput } from './types.js';

interface ToastStore {
  readonly toasts: readonly Toast[];
  readonly show: (input: ToastInput) => string;
  readonly dismiss: (id: string) => void;
  readonly clear: () => void;
}

function toastId() {
  return `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeToast(input: ToastInput): Toast {
  return {
    id: input.id ?? toastId(),
    kind: input.kind,
    title: input.title,
    subtitle: input.subtitle,
    lifetime: input.lifetime ?? { autoDismiss: true, durationMs: DEFAULT_TOAST_DURATION_MS },
  };
}

function insertToast(toasts: readonly Toast[], toast: Toast): readonly Toast[] {
  const nextToasts = [toast, ...toasts.filter((candidate) => candidate.id !== toast.id)];

  if (nextToasts.length <= MAX_VISIBLE_TOASTS) {
    return nextToasts;
  }

  const removableIndex = nextToasts.findLastIndex((candidate) => candidate.lifetime.autoDismiss);
  if (removableIndex === -1) {
    return nextToasts;
  }

  return nextToasts.filter((_, index) => index !== removableIndex);
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (input) => {
    const toast = normalizeToast(input);
    set((state) => ({ toasts: insertToast(state.toasts, toast) }));
    return toast.id;
  },
  dismiss: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    })),
  clear: () => set({ toasts: [] }),
}));

export function showToast(input: ToastInput): string {
  return useToastStore.getState().show(input);
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismiss(id);
}

export function clearToasts(): void {
  useToastStore.getState().clear();
}
