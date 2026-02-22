# Isagi Web (Vite + React) - Development Guide

This document applies to all file edits being made in `apps/web`.

This is a Vite + React SPA for deep work and desktop-first flows.

## Hard rules

- Agents are not allowed to run the dev server or start scripts (no `npm run dev` or `vite preview`). If verification is needed via a browser, ask the user to run those commands.
- **Agents CAN and SHOULD execute quality gates:** Always run the lint and build commands (e.g., `pnpm --filter @isagi/web lint` and `pnpm --filter @isagi/web build` which includes `tsc -b`) after making changes to verify your work.
- **Do not use manual memoization.** The project uses **React Compiler** (Babel plugin), which handles memoization automatically. Avoid using `useMemo`, `useCallback`, and `React.memo`. Write idiomatic, un-memoized React code and trust the compiler.

## Tech stack

- Vite
- React 19 + React Compiler
- React Router (declarative routing mode)
- Tailwind CSS v4 (styling)
- Lucide react for icons
- oRPC (end-to-end type-safe API client)
- TanStack React Query
- Zustand
- PNPM for package management

## Core rules (succinct)

- **Desktop-first:** Design and optimize for desktop screens, keyboard shortcuts, and precise pointer interactions. Mobile/tablet views are secondary.
- **Routing:** Use declarative routing via React Router.
- **Styling:** Default to `className` with Tailwind CSS v4. Avoid inline `style` objects unless calculating dynamic values.
- **Layout:** Rely on Tailwind's flexbox and CSS grid classes for layout structures.

## Package structure

Target structure (React Router + Vite convention):

```
apps/web/
├── src/
│   ├── pages/                # App pages and layouts
│   ├── components/           # Reusable UI components
│   ├── lib/                  # Pure utilities/helpers
│   ├── services/             # API client(s), data fetching
│   ├── stores/               # State management (if/when introduced)
│   ├── routes.tsx            # Router configuration and global providers
│   ├── main.tsx              # App entry point
│   └── global.css            # Tailwind v4 theme imports
├── index.html
├── vite.config.ts
├── eslint.config.js
├── package.json
└── tsconfig.json
```

## Coding conventions

- Avoid changing existing files/components unless needed for the task.
- Prefer small, reusable components; avoid giant files.
- Only add comments for non-obvious logic.
- Prefer the `@/*` import alias (if configured) pointing at `src/*`.
- Add dependencies only when required.

## State + data conventions (when introduced)

### Zustand rules (copied from player-view)

- Avoid using the store object directly. Put selectors in `src/stores/{store_name}.selectors.ts`.
- Do not export the store object. For direct access, add selector functions that use `getState()` and return a subsection.
- Selectors should return only what the component needs; prefer filtering inside selectors (use shallow selection to prevent re-renders).
- Group all actions under an `actions` field; provide a selector that returns the actions object.
- Actions should represent events, not naive setters.

### React Query rules

- Keep a single shared `QueryClient` for the app.
- Prefer query/mutation helpers over ad-hoc fetch calls in components.

### oRPC rules

- Centralize oRPC client setup in `src/services/`.
- Prefer oRPC + React Query integration utilities once React Query is introduced.

## Frontend design scale

Always use the `frontend-design` skill when making UI changes to this app.

- **S (micro):** copy/spacing/tiny styling tweaks; keep existing patterns.
- **M (component):** define loading/empty/error states; a11y labels; robust keyboard navigation support optimized for desktop users.
- **L (screen/flow):** navigation structure; information architecture; polished states; deep-work interactions focused on desktop utility.

## Commands (for agents to verify code quality)

```bash
# quality gates (agents should run these)
pnpm --filter @isagi/web lint
pnpm --filter @isagi/web build # tsc -b is included here for typechecking
```

## Commands (for humans; agents must not execute)

```bash
# dev
pnpm --filter @isagi/web dev
pnpm --filter @isagi/web preview
```
