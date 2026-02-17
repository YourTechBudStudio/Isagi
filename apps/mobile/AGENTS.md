# Isagi Mobile (Expo) - Development Guide

This document applies to all file edits being made in `apps/mobile`.

This is an Expo (React Native) app for capture-first flows and mobile-friendly agent conversations.

## Hard rules

- Agents are not allowed to run this app or its scripts (no `expo start`, no `expo run:*`, no simulators). If verification is needed, ask the user to run commands.
- Do not worry about Expo Web. Avoid adding web-only code/flows.
- Do not manually edit generated native folders: `apps/mobile/ios` and `apps/mobile/android` (they are generated/ignored).

## Tech stack

- Expo SDK 54
- Expo Router v6 (file-based routing)
- React 19 + React Native 0.81
- NativeWind v5 + Tailwind CSS v4 (styling)
- react-native-reanimated, gesture-handler, screens, safe-area-context
- oRPC (end-to-end type-safe API client)
- TanStack React Query
- Zustand
- PNPM for package management

## Core rules (succinct)

- **Routing:** only routes in `src/app/`.
- **Styling:** default to `className`; use `style` only for layout-critical containers.
- **Do not mix** `style` + `className` on the same element.
- **Layout-critical components:** use `style={{ flex: 1 }}` for `SafeAreaView`,
  `PagerView`, and `FlatList`. Keep padding in wrapper Views.
- **ScrollView:** no `style` or `className`; it must be the direct child of a
  flex container. Put padding on an inner View.
- **Stacking:** avoid `zIndex`/absolute layout; keep header → tabs → body → footer.
- **Composer placement:** keep as a footer sibling, not inside the scroll/list.

Font families come from `@theme` tokens in `src/app/global.css` and should be
applied via `className` (e.g., `font-display`, `font-body`).

## Package structure

Target structure (Expo Router + top-level `src/` convention):

```
apps/mobile/
├── src/
│   ├── app/                 # Expo Router routes + layouts only
│   │   ├── _layout.tsx
│   │   ├── index.tsx
│   │   └── global.css        # Tailwind v4 + NativeWind theme imports
│   ├── components/           # Reusable UI components
│   ├── hooks/                # Custom React hooks
│   ├── utils/                # Pure utilities/helpers
│   ├── services/             # API client(s), data fetching, device integrations
│   ├── store/                # State management (if/when introduced)
│   └── constants/            # App constants (avoid magic strings)
├── assets/                   # Images/fonts
├── app.json
├── metro.config.js
├── eslint.config.cjs
├── package.json
└── tsconfig.json
```

## Coding conventions

- Avoid changing existing files/components unless needed for the task.
- Prefer small, reusable components; avoid giant route files.
- Only add comments for non-obvious logic.
- Prefer the `@/*` import alias (configured to point at `src/*`).
- Add dependencies only when required; prefer Expo-compatible packages.

## State + data conventions (when introduced)

### Zustand rules (copied from player-view)

- Avoid using the store object directly. Put selectors in `src/store/{store_name}.selectors.ts`.
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

- **S (micro):** copy/spacing/tiny styling tweaks; keep existing patterns; ensure touch targets remain usable.
- **M (component):** define loading/empty/error states; a11y labels; keyboard avoidance; safe-area correctness.
- **L (screen/flow):** navigation structure; information architecture; polished states; motion restraint (prefer meaningful transitions over constant animation).

## Commands (for humans; agents must not execute)

```bash
# dev
pnpm --filter @isagi/mobile start
pnpm --filter @isagi/mobile ios
pnpm --filter @isagi/mobile android

# quality gates
pnpm --filter @isagi/mobile typecheck
pnpm --filter @isagi/mobile lint
pnpm --filter @isagi/mobile format
```
