# Desktop

## What this is

The Electron desktop shell for Isagi. It owns native app lifecycle, runtime bootstrapping, and renderer loading.

## Structure

- `src/main/` contains Electron main-process code.
- `src/preload/` contains the safe renderer bridge.
- `dist-electron/` is generated build output.

## Effect scope

- Use Effect for native lifecycle orchestration: app boot, runtime process management, IPC handlers that perform work, retries, timeouts, and shutdown. General rules: `docs/engineering-guidance/effect-conventions.md`.
- One `ManagedRuntime` in `src/main/index.ts`, built from `makeDesktopLayer` in `src/main/desktop-layer.ts`. Nothing builds before its first use (after `whenReady`); disposing it is shutdown's service teardown, in reverse build order.
- The services are `RuntimeProcess` (`runtime-process/`), `DesktopUpdater` and `UpdaterDiagnostics` (`updater/`), plus `DesktopShell` (what they need from Electron's `app` and window, implemented in `index.ts`). Their state lives in the layer constructor; status is a `SubscriptionRef` the renderer bridge streams.
- Electron lifecycle callbacks and IPC handlers in `src/main/index.ts` are the only run sites, and they run on that `ManagedRuntime`. The one exception, in the same file, is recording an update-install rejection: the shutdown coordinator's `diagnoseInstallRejection` runs the updater installer's requirement-free `recordInstallRejection` with `Effect.runPromise` and the desktop logger, because the installer runs only after the `ManagedRuntime` is disposed, and every run on a disposed runtime dies with "ManagedRuntime disposed". Do not route it through the desktop runtime. Everything else composes effects (ADR 0012, `effect-conventions.md` §9.4).
- Timers are fibers (`Effect.sleep`, `Schedule`, `FiberHandle`/`FiberSet` owned by a layer scope), never `setTimeout`/`setInterval`.
- Logs go through `Effect.log*` and `DesktopLogger` (`[desktop] <message>` lines); the runtime child's output is a protocol forwarded by `runtime-process/logging.ts`.
- HTTP goes through `effect/http` `HttpClient`, provided once as `RuntimeHttpClient` from `@isagi/runtime-client`.

## Rules

- Keep React UI code in `apps/web`.
- Run `pnpm check` from the repository root after code changes.
