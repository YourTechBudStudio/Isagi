# Run a runtime with `isagi serve`

`isagi serve` runs an Isagi runtime in the current process until it is stopped (Ctrl-C or SIGTERM). Once it listens it prints `ISAGI_RUNTIME_READY <url>`; pass that URL to client commands with `--runtime-url`. Terminals and agents the runtime launches get `ISAGI_RUNTIME_URL` and an `isagi` on `PATH` that call it.

```sh
isagi serve
isagi serve --port 11299
isagi serve --host 0.0.0.0 --data-dir ~/isagi-server
```

| Setting | Flag | Environment variable | Default |
| --- | --- | --- | --- |
| Listen address | `--host <address>` | `ISAGI_HOST` | `server.host` in the global config, else `127.0.0.1`; `0.0.0.0` listens on every interface |
| Listen port | `--port <0-65535>` | `ISAGI_PORT` | `server.port` in the global config, else `0`, a free port chosen at start |
| Data directory | `--data-dir <path>` | `ISAGI_DATA_DIR` | `~/.isagi` |
| Browser origins allowed to call the runtime | `--allowed-origins <origin,…>` | — | none; clients without an origin are always allowed |
| Web workbench build | `--web-root <path>` | — | the copy bundled with `isagi`; served only when `server.serveWebUi` is true |

To use the workbench from a browser on another machine, set `server.serveWebUi: true`, list the hostname you browse to in `server.allowedHosts`, and put HTTPS in front (for example `tailscale serve`); the [global schema](config-global.schema.ts) has the details.

A flag beats its environment variable, which beats the default. For the listen address and port, the `server` section of that data directory's `config.yaml` ([global schema](config-global.schema.ts)) sits between the environment variable and the default, and is the place to set them for a desktop-managed runtime, which passes neither flag. An empty environment variable counts as unset. An invalid value fails the command (`cli_usage_invalid`, exit 2) and is never replaced by a lower tier. Use a fixed port for a runtime you return to; with the default the port changes on every start. A runtime with another `--data-dir` is a separate Isagi with its own projects, runs and config.

With `--json`, only a failure before the runtime starts is a JSON document: a refused setting, or `runtime_load_failed` when the runtime cannot be loaded (most often native modules built for another Node version; reinstall with the Node you run it with). Once the runtime starts, startup failures are its own `ISAGI_RUNTIME_STARTUP_FAILED` line on stderr, and it exits non-zero.
