# Web

- Keep Electron-specific logic out of this package.

## State

- One `AtomRegistry` per app session (`makeAppRegistry`, provided through `AppStateProvider`). Never use atom-react's `RegistryProvider`: it creates, and later disposes, a second registry.
- Only `lib/state` runs effects (`runApp`, `forkApp`). Components and helpers never do; non-Effect subsystems get Promise-returning functions built with `runApp`.
- Runtime writes are `Effect.uninterruptible`, so a second click or an unmount never aborts a request that reached the runtime.
- Invalidation keys are exact; there is no prefix invalidation, so invalidate every key a write changed.
- Build query atoms at module level or in `Atom.family` with primitive keys, never in render.

## UI

- Sentence-level user-facing prose (toasts, empty states, error summaries, recovery guidance) lives in `src/copy/`. Copy modules export strings, objects and string-returning functions, never JSX.
- Colors, type, motion and depth come from the design tokens in `src/styles.css`, never hard-coded hex.
- Agent and process state uses the attention semantics `working` / `waiting` / `idle` / `error`, not raw accent colors (those are for decoration).
- Animate with the one easing curve, `ease-expo`, and the `duration-micro` / `duration-ui` / `duration-surface` / `duration-room` ladder; no spring overshoot.
- Follow the `design-system` skill for everything else.

## Tests

- One isolated registry per test (`makeTestRegistry`), always disposed in `t.after(() => registry.dispose())`: retained queries hold timers that keep the process alive.
- Drive time with node's `mock.timers`, not `TestClock`, which cannot drive reactivity timers. Call `flush()` before ticking.
- Fakes record calls lazily, inside `Effect.sync`/`Effect.suspend`, because building an effect is not running it.
- Browser tests and fixtures follow [browser/AGENTS.md](browser/AGENTS.md).
