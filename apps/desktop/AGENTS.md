# Desktop

- UI stays in `apps/web`; this package owns native lifecycle, runtime bootstrapping and renderer loading.
- Effects run only in Electron lifecycle callbacks and IPC handlers in `src/main/index.ts`, on the one `ManagedRuntime`, which builds lazily after `whenReady`. The one exception, recording an update-install rejection after that runtime is disposed, is explained beside `diagnoseInstallRejection`.
