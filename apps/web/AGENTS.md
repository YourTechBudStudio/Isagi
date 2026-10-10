# Web

## What this is

The React frontend for Isagi. Electron loads this app, and it can later be hosted as a web interface.

## Tech stack

- **React 19** for the UI layer.
- **React Router 7** using simple declarative routing (`<Routes>` / `<Route>`), not the data/loader router APIs.
- **Effect** (`effect`, `effect/reactivity`, `@effect/atom-react`) for runtime calls, server state and client state (see State and Effect scope below).
- **Tailwind CSS 4** for styling, themed with Isagi's design tokens (see Styling conventions).
- **Base UI** (`@base-ui/react`) for unstyled, accessible UI primitives that we style with Tailwind.
- **lucide-react** for icons. Prefer Lucide icons over text/emoji glyphs in chrome.
- **Framer Motion** (`motion`, imported from `motion/react`) for animation. It is the default for transitions, the morphing command palette, and any orchestrated entrance. Use the design system's easing/duration tokens rather than ad-hoc values.
- **TypeScript 7** for type safety.

## Structure

- `src/` contains React, routing, client wiring, and styles.
- `dist/` is generated build output.

A simple, recommended layout inside `src/`:

```
src/
  main.tsx                # App entry, mounts React, wires providers
  App.tsx                 # Root component, declares routes
  styles.css              # Tailwind entry + global styles
  routes/                 # Page-level components, one per route
    <page-name>/          # A page and its page-specific components
  components/             # Reusable, shared components
    ui/                   # Base UI primitives wrapped + styled with Tailwind
  copy/                   # Reviewable sentence-level UI prose
  hooks/                  # Reusable React hooks
  lib/
```

- Keep the root of `src/` as empty as possible — only `main.tsx`, `App.tsx`, and `styles.css` live there. Client and runtime wiring goes in `lib/`.
- `components/` holds components shared across pages.
- Page-specific components live alongside their page inside `routes/<page-name>/`.
- Sentence-level user-facing prose lives in `copy/`: toasts, empty states, error summaries, recovery guidance, onboarding text, and similar copy. Short chrome labels may stay local. Copy modules may export strings, objects, and string-returning functions, but not JSX or layout behavior.

### Page components

- Each page folder has one entry component named `<PageName>Page` in a file of the same name (e.g. `routes/settings/SettingsPage.tsx` exports `SettingsPage`).
- Page-specific components sit next to it in the same folder; nested pages get their own subfolder.

```
src/routes/
  HomePage.tsx                 # exports HomePage  →  /
  settings/
    SettingsPage.tsx           # exports SettingsPage  →  /settings (renders <Outlet />)
    SettingsNav.tsx            # page-specific component
    general/
      GeneralSettingsPage.tsx  # exports GeneralSettingsPage  →  /settings/general
    profile/
      ProfileSettingsPage.tsx  # exports ProfileSettingsPage  →  /settings/profile
```

Nested routes are declared in `App.tsx` and the parent renders an `<Outlet />`:

```tsx
<Routes>
  <Route path="/" element={<HomePage />} />
  <Route path="settings" element={<SettingsPage />}>
    <Route path="general" element={<GeneralSettingsPage />} />
    <Route path="profile" element={<ProfileSettingsPage />} />
  </Route>
</Routes>
```

Keep this flat and grow it only when a folder earns its place.

## Styling conventions

All color, type, motion, and depth come from the design tokens defined in `src/styles.css` (`@theme`). Treat them as the single source of truth.

- **Use token-backed utilities, never hardcoded hex.** `bg-canvas`, `text-fg-muted`, `border-line`, `ease-expo`, `shadow-soft`, `rounded-md`, `font-mono` — not `#24273a` or arbitrary `cubic-bezier(...)`.
- **Express meaning with the attention semantics, not raw accents.** When a color communicates agent/process state, use `working` / `waiting` / `idle` / `error` (e.g. `bg-working`, `text-waiting`) instead of `violet` / `cyan` / `red`. Raw accent tokens (`blue`, `violet`, `amber`, `green`, `red`, `cyan`) are for decoration and brand use, not for encoding state. This keeps state meaning in one place if a color is ever re-tuned.
- **One easing curve.** Animate with `ease-expo` and the `duration-micro` / `duration-ui` / `duration-surface` / `duration-room` ladder. Fast start, soft landing; never spring-bouncy overshoot.
- Follow the Isagi design system skill for everything else (voice, spatial composition, atmosphere, where humour does and doesn't belong).

## State and Effect scope

Server state and client state are Effect atoms (`effect/reactivity` + `@effect/atom-react`). ADR 0001 says who owns each fact, ADR 0012 records the tooling, and `docs/engineering-guidance/effect-conventions.md` has the general Effect rules. The building blocks live in `src/lib/state/`:

- `registry.ts`: `makeAppRegistry()`, `useRegistry()`, `useAppRun()`. `AppStateProvider.tsx` provides the registry to our hooks and atom-react's hooks.
- `runtime.ts`: `appRuntime` (built from `runtimeApiLayerAtom`, the `RuntimeApi` service in `lib/runtime/client.ts`), `runApp`, `forkApp`, `provideApp`, `invalidateKeys`, `AppRequirements`.
- `policy.ts`: `query`, `observe`, `pollWhile`, `disabledQuery`, `peek`, `patch`, `refreshAndRead`, `revalidate`, `connectBrowserRevalidation`, `queryRetryAtom`.
- `keys.ts` (invalidation keys), `result.ts` (`queryError`, `mutationError`, `mutationData`), `channel.ts` (`sessionObject`, `makeChannel`, `makeLatestWins`), `testing.ts` (test-only).

### One registry per app session

- `main.tsx` creates the registry with `makeAppRegistry()`, calls `connectBrowserRevalidation`, and renders `AppStateProvider`. Browser fixtures do the same through `browser/fixture/test-support/registry.ts`. No module exports a registry.
- Never use atom-react's `RegistryProvider` (it creates and later disposes a second registry; oxlint rejects it) and never rely on `RegistryContext`'s default value.
- Reaching the registry: Effect code reads `AtomRegistry.AtomRegistry` from its context (provided inside atoms and by `runApp`/`forkApp`); plain functions take `registry` as their first parameter; React code calls `useRegistry()`, which throws outside `AppStateProvider`.

### Patterns

- **Runtime-owned reads** are `query(read, policy)` atoms built at module level or inside `Atom.family` with primitive keys (ids), never in render. Defaults: 10 s stale, revalidate on focus and reconnect, retry 3 times at 1/2/4 s, 5 min retention; override per query (`staleTime`, `idleTTL`, `retry`). A per-observer freshness need is `observe(view, { staleTime, pollEvery })`; conditional polling is `pollWhile`; `enabled: false` is `disabledQuery`.
- **Invalidation** uses flat string keys from `keys.ts` only: `Reactivity.invalidate` inside effects, `invalidateKeys(registry, [...])` elsewhere. Keys are exact; there is no prefix invalidation.
- **Commit paths** (what the client does after a runtime write) are `Effect.fn` functions in `lib/<domain>/commits.ts`-style modules, run with `useAppRun()` in React handlers, `ctx.app` in palette commands, or `forkApp` when detached from a component. Read-after-write is `refreshAndRead`; an awaited refresh is `revalidate`; a local cache edit is `patch` (held success only).
- **Runtime writes are `Effect.uninterruptible`**, so a second click or an unmount never aborts a request that reached the runtime.
- **Component-owned mutations** with their own pending/error state are per-instance `appRuntime.fn` atoms built in `useMemo` (for example `makeRecheckProjectAtom`), read through `AsyncResult` and the `result.ts` helpers.
- **Client interaction state** (selection, drawers, toasts, attention, palette, rail order, pending deletes) is keepAlive state atoms plus `(registry, ...)` action functions that are the only writers. React reads them with `useAtomValue(atom)` or `useAtomValue(atom, selector)`. Local `useState` stays fine for state no one else reads.
- **Long-lived session work** is either a resource atom (`appRuntime.atom(Effect.gen(...))`, owning fibers through `FiberHandle`/`FiberMap`, kept alive or mounted with `useAtomMount`: `runtimeConnectionAtom`, `workflowLiveAtom`, `backgroundSyncAtom`) or a session object (`sessionObject(registry => ...)`, a plain imperative object for DOM and callback subsystems: `workbenchFocusAtom`, `selectionSyncAtom`, `terminalFactsAtom`). Rendered state never lives in a session object.
- **Run sites**: only `lib/state/runtime.ts` (`runApp`, `forkApp`) and `lib/state/registry.ts` (`AtomRegistry.make`). Components and helpers never call `Effect.run*`; non-Effect subsystems (terminal presentation, PTY streams) receive Promise-returning functions built with `runApp(registry, effect, { signal })`.
- Do not wrap presentational components, JSX, simple hooks, or pure UI helpers in Effect, and do not return `Effect` from components or selectors.

### Tests

- One isolated registry per test: `makeTestRegistry({ api, retry, initialValues })` from `lib/state/testing.ts`, and always `t.after(() => registry.dispose())` (retained queries hold timers that keep the process alive).
- Fakes are lazy: record a call inside `Effect.sync`/`Effect.suspend`, because building an effect is not running it. Unspecified `RuntimeApi` members die with "`RuntimeApi.<member>` is not used".
- Drive time with node's `mock.timers` (`setTimeout`, `Date`), not `TestClock`; call `flush()` before ticking (`advance(ms)` does both).
- Browser fixtures keep stubbing `window.fetch` / `window.isagi` and use the production `RuntimeApi.layer`; seed `[queryRetryAtom, null]` to fail fast.

## Rules

- Keep Electron-specific logic out of this package.
- We dont need to preserve backward compatiblity for mocked data. Once we have binding with the backend runtime, feel free to remove the mock data we dont need anymore.

- Put disposable prototypes in gitignored `browser/playground/`; no tests are required for exploration. For browser testing, follow [browser/AGENTS.md](browser/AGENTS.md).
