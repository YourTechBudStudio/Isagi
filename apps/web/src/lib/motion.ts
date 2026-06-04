import type { Transition } from 'motion/react';

/**
 * Shared motion vocabulary. Every animation in the app uses this one easing
 * curve and duration ladder so the whole shell feels like one continuous
 * surface — fast start, soft landing, never a spring overshoot. Mirrors the
 * `--ease-expo` / `--duration-*` design tokens.
 */
export const EASE_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];

export const DURATION = {
  micro: 0.11,
  ui: 0.19,
  surface: 0.32,
  room: 0.6,
} as const;

/** Surface-scale move (expand/collapse, panel). */
export const surfaceTransition: Transition = { duration: DURATION.surface, ease: EASE_EXPO };

/** UI-scale move (highlight slide, crossfade). */
export const uiTransition: Transition = { duration: DURATION.ui, ease: EASE_EXPO };

/** Zen expand/collapse — a deliberate, room-scale morph of the canvas. */
export const zenTransition: Transition = { duration: 0.42, ease: EASE_EXPO };
