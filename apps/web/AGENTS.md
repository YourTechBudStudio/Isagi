# Web

- Keep Electron-specific logic out of this package.
- Runtime writes are `Effect.uninterruptible`, so a second click or an unmount never aborts a request that reached the runtime.
- Invalidation keys are exact; there is no prefix invalidation, so invalidate every key a write changed.
- Sentence-level user-facing prose (toasts, empty states, error summaries, recovery guidance) lives in `src/copy/`.
- Style only with the design tokens in `src/styles.css`, never hard-coded hex, and follow the `design-system` skill.
- Every color must work in both themes (Macchiato dark, Latte light, chosen by `data-theme` on the root). Hover and selection washes use `tint` (`bg-tint/6`), recessed wells use `scrim` and text on a solid accent fill uses `on-accent`, never `white`, `black` or a surface token; never branch on the theme in components.
- The Fluidcast player follows the same `data-theme` with its own copy of both palettes; never restyle it from here. A palette change lands in Fluidcast's `player.css` too, which `lib/fluidcast/theme-tokens.test.ts` checks.
- A color that shows agent or process state uses the attention tokens (`working`, `waiting`, `idle`, `error`), never a raw accent such as `violet` or `cyan`.
- Browser tests and fixtures follow [browser/AGENTS.md](browser/AGENTS.md).
