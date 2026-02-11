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
- PNPM for package management

### Planned (add only when needed)

- oRPC (end-to-end type-safe API client)
- TanStack React Query
- Zustand

## Technical specification

- **Routing:** All routes live in `src/app/` (Expo Router). Do not put non-route modules inside `src/app/`.
- **Styling:** Prefer NativeWind `className` for layout and styling. Keep global Tailwind/NativeWind imports in `src/app/global.css`.
- **UX posture:** Mobile is code-free. It supports capture, triage, and decisions; repo/coding workflows stay desktop-first.

### NativeWind v5 critical constraint: never mix `style` and `className`

In NativeWind v5, the `style` prop **completely overrides** all styles applied via `className` — even for non-overlapping properties. This means that if you set `fontFamily` via `style` and `color` via `className`, the color will be silently dropped.

**Rule: never pass both `style` and `className` on the same element.** Put everything through `className` using Tailwind utilities and custom `@theme` tokens.

```tsx
// BAD — className color will be silently dropped
<Text style={{ fontFamily: "Sora_700Bold" }} className="text-white text-xl">

// GOOD — everything via className using @theme font tokens
<Text className="font-display text-white text-xl">
```

Font families are defined as `@theme` tokens in `global.css` (e.g., `--font-display`, `--font-body`) and used via `font-display`, `font-body`, etc. className utilities.

The only safe exception is `Animated` styles from `useAnimatedStyle()` applied to `Animated.View` / `Animated.Text` — those control layout transforms (opacity, translateY) and don't conflict with className visual styles, as long as you don't set color/font/background properties in the animated style.

### NativeWind v5 critical constraint: no `style` or `className` on ScrollView

`ScrollView` must have **zero** `style` and **zero** `className` props — both silently break rendering and make content invisible. Place ScrollView as a direct child of a flex container (e.g. `SafeAreaView` with `flex-1`), and use a child `<View>` for content padding. Do **not** wrap ScrollView in a `<View className="flex-1">` — that also breaks it.

```tsx
// BAD — content will be invisible
<ScrollView className="flex-1" contentContainerClassName="px-5 pt-4">
// ALSO BAD — style breaks it too
<ScrollView style={{ flex: 1 }}>
// ALSO BAD — flex-1 wrapper breaks it
<View className="flex-1"><ScrollView>...</ScrollView></View>

// GOOD — ScrollView as direct child of flex container, zero props
<SafeAreaView className="flex-1" edges={["top"]}>
  <ScrollView>
    <View className="px-5 pt-4">
      {/* content */}
    </View>
  </ScrollView>
</SafeAreaView>
```

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
