# Web

## What this is

The React frontend for Isagi. Electron loads this app, and it can later be hosted as a web interface.

## Structure

- `src/` contains React, routing, client wiring, and styles.
- `dist/` is generated build output.

## Effect scope

- Use Effect for runtime client calls, async user actions, retries, and typed failure transitions.
- Do not wrap presentational components, JSX, simple hooks, or pure UI helpers in Effect by default.
- Keep Effect usage near the client/data layer unless UI behavior genuinely needs an effectful workflow.

## Rules

- Keep Electron-specific logic out of this package.
