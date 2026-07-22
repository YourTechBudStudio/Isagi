# Development runtime

This document describes how Isagi starts, owns, and diagnoses its development runtime. It is implementation-level maintainer documentation; the durable client/runtime boundary remains in [`architecture.md`](./architecture.md).

## Commands

| Command                                                        | Behavior                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                                     | Prepares and starts the complete worktree-local development stack. This is the normal development command.            |
| `pnpm dev:install-launcher`                                    | Installs or updates this worktree's user-level Linux launcher so GNOME can resolve the development icon and name.     |
| `pnpm dev:prepare`                                             | Builds the workspace in dependency order and assembles the canonical Electron-targeted runtime stage.                 |
| `pnpm dev:uninstall-launcher`                                  | Removes the user-level Linux launcher only when it is owned by Isagi development integration.                         |
| `pnpm --filter @isagi/web dev`                                 | Starts only Vite, prints its resolved URL, and keeps HMR available. It does not start or proxy the runtime.           |
| `pnpm --filter @isagi/runtime dev`                             | Builds required workflow assets and starts one non-watching runtime on an ephemeral loopback port.                    |
| `pnpm --filter @isagi/desktop stage:runtime`                   | Builds the runtime and assembles the canonical Electron-targeted runtime stage.                                       |
| `pnpm --filter @isagi/desktop stage:runtime -- --force-native` | Removes and rebuilds the matching Electron-native cache before assembling the stage.                                  |
| `pnpm --filter @isagi/desktop smoke:runtime-stage`             | Validates and smokes the canonical stage and a relocated copy under Electron Node mode.                               |
| `pnpm pack:desktop`                                            | Builds the workspace, creates an unpacked desktop application, checks stage parity, and smokes the packaged runtime.  |
| `pnpm package:desktop`                                         | Builds the workspace, creates configured desktop distributions, checks stage parity, and smokes the packaged runtime. |

Direct package commands are composable primitives, not replacements for root supervision. A direct desktop launch needs an already running web origin, for example `ISAGI_WEB_URL=http://127.0.0.1:5173 pnpm --filter @isagi/desktop dev`. Plain-browser web development needs an explicit `VITE_ISAGI_RUNTIME_URL`; Electron never uses that value for runtime discovery.

## Desktop application identity

Isagi uses `studio.yourtechbud.isagi` as its stable application identity across desktop platforms. Electron Builder's `appId` becomes the macOS bundle identifier, while the Linux-only package field `desktopName` is `studio.yourtechbud.isagi.desktop`; Linux packaging synchronizes that filename with the Wayland application ID and X11 `WM_CLASS` so the shell can associate a running window with its launcher and icon.

`pnpm dev` reads the same `desktopName`, but it deliberately does not install a launcher into the user applications directory. On Linux, run `pnpm dev:install-launcher` once and restart `pnpm dev` so GNOME can resolve the application name and icon; run `pnpm dev:uninstall-launcher` to remove it. The explicit commands make the host mutation visible, refuse to overwrite a launcher they do not own, and make the last installed worktree the development launch target. Remove the development launcher before integrating a production AppImage at the same user-level path.

Installer-style Linux distributions should install their generated desktop entry and icon as part of installation. An AppImage carries its generated desktop metadata and icon, but running the portable file directly is not installation; complete dock and launcher integration still requires an AppImage integration mechanism or a separate installer script. The synchronized identity keeps either integration path aligned with the running window.

## Ownership topology

```text
pnpm dev
  ├─ deterministic preparation
  │    ├─ workspace build
  │    └─ runtime stage assembly
  └─ outer stack owner
       └─ controller and inherited development process group
            ├─ Vite
            └─ Electron
                 ├─ renderer
                 └─ managed staged runtime in Electron Node mode
```

The outer stack owner is the crash fallback. On POSIX, the controller leads one inherited process group; if the controller exits or crashes, the owner kills that group. The controller owns normal Effect-scoped shutdown and stops Electron before Vite so Electron can stop its runtime. On Windows, the controller registers top-level child PIDs with the owner, which uses `taskkill /T /F` because Windows has no equivalent POSIX process group.

The first Ctrl-C requests structured shutdown. During the graceful path, the root command remains alive until the children have exited, their output streams have closed, final labelled output has been presented, and the outer owner has confirmed the owned tree is gone. If output cannot drain within its bound, the controller reports that fact and yields residual cleanup to the outer owner. A repeated Ctrl-C or expiry of the grace period bypasses graceful cleanup and kills the remaining tree, but still waits for disappearance before returning. A runtime failure in development exits Electron nonzero, preserves runtime output under the `runtime` log label, and brings down the complete stack. Nothing automatically restarts or replaces the runtime.

## Startup ordering

Preparation completes before the long-lived supervisor starts. The recursive workspace build follows the declared package dependency graph, so packages whose exports point at generated `dist` files are built before their consumers. Runtime staging then assembles the already-built runtime without rebuilding it. This makes a fresh worktree deterministic and keeps finite build work out of the process supervisor.

After preparation, the controller starts Vite and waits for its versioned readiness record. Vite prefers `127.0.0.1:5173` and uses Vite's normal fallback when that port is occupied, so consumers never assume the selected port. The controller then starts Electron with the resolved URL. Electron starts exactly one managed staged runtime, which binds `127.0.0.1` on port `0`, publishes its selected URL through readiness, and must pass health before the preload bridge releases that URL.

The renderer's host lifecycle gate disables runtime-backed queries until the managed lifecycle is ready. A managed host failure keeps stale control-plane or workspace state unmounted and freezes the boot track in its error tone during the brief interval before Electron exits. The persistent boot surface spans host connection, control-plane discovery, and workspace opening; there is no native splash, managed-runtime recovery UI, or second runtime discovery path. In both development and packaged execution, an unexpected managed-runtime failure is fatal to Electron and exits nonzero after diagnostics are preserved. External runtime endpoints remain externally owned and retain their query-driven retry behavior.

## Private development protocol

[`scripts/dev-supervisor/dev-protocol.mjs`](../scripts/dev-supervisor/dev-protocol.mjs) is the runtime source of truth for private development record prefixes, the protocol version, supervisor environment keys, and worktree-local paths. Its adjacent TypeScript declaration is checked for agreement.

The protocol carries:

- `ISAGI_WEB_READY` records from the Vite launcher with the resolved URL.
- `ISAGI_DEV_LOG` records from Electron to the controller with base64-framed runtime output and explicit stdout/stderr identity.
- private environment values used only to connect the owner, controller, Electron, and worktree-local paths.

Malformed, duplicate, missing, or version-mismatched readiness and log records are terminal development failures. Runtime log framing preserves ANSI data, blank lines, carriage returns, multiline output, stderr, and final unterminated data. Private development values and stale `VITE_ISAGI_RUNTIME_URL` values are removed before managed runtime launch, so runtime commands and agent harnesses cannot inherit supervisor paths or protocol values.

These records and environment keys are internal implementation details, not supported user configuration.

## Worktree isolation

The canonical checkout path is the isolation identity. Each worktree owns:

- runtime data at `data/.isagi`
- Electron `userData` at `data/.isagi/electron-user-data`
- the development lock at `data/.isagi/dev-supervisor.lock`
- generated stages and native caches under `apps/desktop/.generated`

Different worktrees can run concurrently. A second `pnpm dev` in the same worktree fails with the live owner PID and lock path. A demonstrably stale lock with valid metadata is recovered once. Missing or malformed lock metadata is not removed automatically; first verify that no development stack from that worktree is running, then remove `data/.isagi/dev-supervisor.lock` manually.

## Runtime staging and native isolation

The canonical stage is `apps/desktop/.generated/runtime`. It contains the runtime entry, generated assets, migrations, a minimal package manifest, the complete external dependency closure, Electron-targeted native modules, and `runtime-stage.json`. Development launches this stage in Electron Node mode. Packaging copies the same layout to `process.resourcesPath/runtime` and launches it through the same lifecycle manager. The private `@isagi/runtime-stage-dependencies` workspace package is the explicit materialization boundary for that external closure; staging deploys it directly instead of traversing and pruning the runtime's bundled workspace dependency graph.

The Electron-native cache fingerprint covers the complete lockfile, exact external dependency versions, Electron version, embedded Node version, ABI, platform, architecture, Linux libc identity where applicable, `@electron/rebuild`, native/external declarations, and the staging recipe version. Runtime JavaScript, assets, and migrations are rebuilt and reassembled on every stage command, so they do not belong in the native rebuild fingerprint.

Ordinary Node workspace modules and Electron-targeted native modules use different ABI outputs even when both embed Node 24. Staging materializes and rebuilds the Electron closure under `.generated`; never rebuild the shared workspace modules for Electron. Use `pnpm --filter @isagi/desktop stage:runtime -- --force-native` when the matching native cache is suspect.

Packaged verification reports separate evidence:

- byte parity for the runtime entry, generated assets, migrations, manifests, native modules, and selected native helpers
- layout parity for that selected payload
- permission parity for executable `node-pty` helpers where the target platform ships them
- behavioral smoke for runtime readiness, health, native SQLite loading, PTY creation, clean shutdown, and relocation

The unpacked unsigned application is expected to preserve those selected bytes and permission modes. Release-container metadata, timestamps, caches, and signatures are outside the parity comparison.

## Logs and troubleshooting

The controller labels output as `web`, `desktop`, `runtime`, or `dev`. TTY output uses stable colors while redirected output strips ANSI control sequences. Both stdout and stderr are retained.

When startup fails, read the first terminal cause and the immediately preceding source-labelled output. Common checks are:

1. If Vite does not become ready, inspect the `web` output; an occupied `5173` is normal only when Vite reports its fallback URL.
2. If preparation fails, rerun `pnpm dev:prepare`; if the native cache is suspect, rerun `pnpm --filter @isagi/desktop stage:runtime -- --force-native`.
3. If Electron reports an invalid stage, inspect `apps/desktop/.generated/runtime/runtime-stage.json` and rerun staging rather than editing generated files.
4. If the same-worktree lock blocks startup, use its PID to verify whether the owner is alive before removing anything.
5. If the managed runtime exits, preserve the `runtime` and `desktop` output. Development intentionally requires a complete `pnpm dev` rerun after runtime or desktop source changes.

In a packaged app, the latest managed-runtime failure snapshot is written before shutdown to `logs/managed-runtime-failure.json` under Electron's `userData` directory. The record includes the failure reason, structured diagnostic, lifecycle revision, and timestamp; ask an affected user for that file when terminal output is unavailable.

Vite is the only hot-reloaded process. Web edits use HMR; runtime and desktop edits take effect only after stopping and rerunning the entire root command.

## Platform evidence

Packaging, native loading, process cleanup, and UI behavior must be reported per locally exercised target. Deterministic tests cover POSIX process groups, Windows PID-tree command construction, signal mapping, environment sanitization, and platform selection, but those tests are not packaged-platform evidence. Do not claim Linux or Windows packaging success from a macOS run.
