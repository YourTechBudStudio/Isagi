# Web

## What this is

The React frontend for Isagi. Electron loads this app, and it can later be hosted as a web interface.

## Tech stack

- **React 19** for the UI layer.
- **React Router 7** using simple declarative routing (`<Routes>` / `<Route>`), not the data/loader router APIs.
- **Effect** for runtime client calls and effectful workflows (see Effect scope below).
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

All color, type, motion, and depth come from the design tokens defined in `src/styles.css`
(`@theme`). Treat them as the single source of truth.

- **Use token-backed utilities, never hardcoded hex.** `bg-canvas`, `text-fg-muted`,
  `border-line`, `ease-expo`, `shadow-soft`, `rounded-md`, `font-mono` — not `#24273a` or
  arbitrary `cubic-bezier(...)`.
- **Express meaning with the attention semantics, not raw accents.** When a color
  communicates agent/process state, use `working` / `waiting` / `idle` / `error`
  (e.g. `bg-working`, `text-waiting`) instead of `violet` / `cyan` / `red`. Raw accent
  tokens (`blue`, `violet`, `amber`, `green`, `red`, `cyan`) are for decoration and brand
  use, not for encoding state. This keeps state meaning in one place if a color is
  ever re-tuned.
- **One easing curve.** Animate with `ease-expo` and the `duration-micro` / `duration-ui`
  / `duration-surface` / `duration-room` ladder. Fast start, soft landing; never
  spring-bouncy overshoot.
- Follow the Isagi design system skill for everything else (voice, spatial composition,
  atmosphere, where humour does and doesn't belong).

## Effect scope

- Use Effect for runtime client calls, async user actions, retries, and typed failure transitions.
- Do not wrap presentational components, JSX, simple hooks, or pure UI helpers in Effect by default.
- Keep Effect usage near the client/data layer unless UI behavior genuinely needs an effectful workflow.

## Rules

- Keep Electron-specific logic out of this package.
- We dont need to preserve backward compatiblity for mocked data. Once we have binding with the backend runtime, feel free to remove the mock data we dont need anymore.
