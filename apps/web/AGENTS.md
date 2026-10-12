# Web

- Keep Electron-specific logic out of this package.
- Runtime writes are `Effect.uninterruptible`, so a second click or an unmount never aborts a request that reached the runtime.
- Invalidation keys are exact; there is no prefix invalidation, so invalidate every key a write changed.
- Sentence-level user-facing prose (toasts, empty states, error summaries, recovery guidance) lives in `src/copy/`.
- Style only with the design tokens in `src/styles.css`, never hard-coded hex, and follow the `design-system` skill.
- A color that shows agent or process state uses the attention tokens (`working`, `waiting`, `idle`, `error`), never a raw accent such as `violet` or `cyan`.
- Browser tests and fixtures follow [browser/AGENTS.md](browser/AGENTS.md).
