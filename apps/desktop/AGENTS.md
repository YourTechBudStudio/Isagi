# Desktop

## What this is

The Electron desktop shell for Isagi. It owns native app lifecycle, runtime bootstrapping, and renderer loading.

## Structure

- `src/main/` contains Electron main-process code.
- `src/preload/` contains the safe renderer bridge.
- `dist-electron/` is generated build output.

## Effect scope

- Use Effect for native lifecycle orchestration: app boot, runtime process management, IPC handlers that perform work, retries, timeouts, and shutdown.
- Treat Electron callbacks, IPC handlers, and app lifecycle hooks as acceptable Effect boundaries.
- Keep reusable desktop operational internals Effect-shaped where cancellation, cleanup, retries, or failure context matter.

## Rules

- Keep React UI code in `apps/web`.
- Run `pnpm check` from the repository root after code changes.
