# Desktop

## What this is

The Electron desktop shell for Isagi. It owns native app lifecycle, runtime bootstrapping, and renderer loading.

## Structure

- `src/main/` contains Electron main-process code.
- `src/preload/` contains the safe renderer bridge.
- `dist-electron/` is generated build output.

## Rules

- Keep React UI code in `apps/web`.
- Run `pnpm check` from the repository root after code changes.
