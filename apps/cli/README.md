# @yourtechbudstudio/isagi

Isagi gives you resumable, worktree-based development environments. This package is the `isagi` command: `isagi serve` runs an Isagi runtime, and `isagi workflows` talks to one.

## Install

Requires Node.js ^24 || ^26.

```sh
npm install --global @yourtechbudstudio/isagi
```

## Run a runtime

```sh
isagi serve
isagi serve --port 11299
isagi serve --host 0.0.0.0 --data-dir ~/isagi-server
```

`isagi serve` runs until it is stopped (Ctrl-C or SIGTERM) and prints `ISAGI_RUNTIME_READY` with its URL once it listens.

| Flag                           | Environment variable | Default                                                |
| ------------------------------ | -------------------- | ------------------------------------------------------ |
| `--host <address>`             | `ISAGI_HOST`         | `server.host` in `config.yaml`, else `127.0.0.1`       |
| `--port <0-65535>`             | `ISAGI_PORT`         | `server.port` in `config.yaml`, else `0` (a free port) |
| `--data-dir <path>`            | `ISAGI_DATA_DIR`     | `~/.isagi`                                             |
| `--allowed-origins <origin,…>` | —                    | none                                                   |
| `--web-root <path>`            | —                    | the copy bundled with `isagi`; every runtime serves it |

A flag beats its environment variable, which beats `config.yaml` in the data directory, which beats the default. Run `isagi --help` or `isagi serve --help` for every command and flag; add `--json` for machine-readable errors.

## More

https://github.com/YourTechBudStudio/Isagi
