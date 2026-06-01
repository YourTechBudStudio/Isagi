# Web

## What this is

The React frontend for Isagi. Electron loads this app, and it can later be hosted as a web interface.

## Tech stack

- **React 19** for the UI layer.
- **React Router 7** using simple declarative routing (`<Routes>` / `<Route>`), not the data/loader router APIs.
- **Effect** for runtime client calls and effectful workflows (see Effect scope below).
- **Tailwind CSS 4** for styling.
- **Base UI** (`@base-ui/react`) for unstyled, accessible UI primitives that we style with Tailwind.
- **lucide-react** for icons.
- **TypeScript 6** for type safety.

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
  hooks/                  # Reusable React hooks
  lib/                    # client.ts, runtime.ts, Effect workflows, pure helpers
```

- Keep the root of `src/` as empty as possible — only `main.tsx`, `App.tsx`, and `styles.css` live there. Client and runtime wiring goes in `lib/`.
- `components/` holds components shared across pages.
- Page-specific components live alongside their page inside `routes/<page-name>/`.

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

## Effect scope

- Use Effect for runtime client calls, async user actions, retries, and typed failure transitions.
- Do not wrap presentational components, JSX, simple hooks, or pure UI helpers in Effect by default.
- Keep Effect usage near the client/data layer unless UI behavior genuinely needs an effectful workflow.

## Rules

- Keep Electron-specific logic out of this package.
