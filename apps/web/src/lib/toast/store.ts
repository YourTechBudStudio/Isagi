/**
 * Visible toasts: frontend interaction state, one list per app session (registry).
 *
 * `toastsAtom` is what `ToastViewport` renders; the actions below are the only writers. React code
 * gets the registry from `useRegistry()`, non-React code takes it as its first parameter.
 */
import { Atom, type AtomRegistry } from 'effect/reactivity';

import { DEFAULT_TOAST_DURATION_MS, MAX_VISIBLE_TOASTS } from './constants.js';
import type { Toast, ToastInput } from './types.js';

/** Newest first, at most `MAX_VISIBLE_TOASTS` unless the extra ones never auto-dismiss. */
export const toastsAtom = Atom.make<readonly Toast[]>([]).pipe(Atom.keepAlive);

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

/** Shows a toast (replacing one with the same id) and returns its id. */
export function showToast(registry: AtomRegistry.AtomRegistry, input: ToastInput): string {
  const toast = normalizeToast(input);
  registry.update(toastsAtom, (toasts) => insertToast(toasts, toast));
  return toast.id;
}

export function dismissToast(registry: AtomRegistry.AtomRegistry, id: string): void {
  registry.update(toastsAtom, (toasts) => toasts.filter((toast) => toast.id !== id));
}

export function clearToasts(registry: AtomRegistry.AtomRegistry): void {
  registry.set(toastsAtom, []);
}
