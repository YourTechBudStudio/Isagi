# Project config

Commands for Git and folder projects, plus worktree setup hooks for Git projects.

## The file

```
.isagi/config.yaml
```

in the project root, optionally committed in Git projects. Edits take effect without a restart. Changing Git worktree hooks prompts for trust again on the next creation; warn the user.

For folder projects, configure ordinary commands normally. Worktree setup hooks and command `postCreate` do not apply; do not configure them for folder setup.

## Two roots, and which one a path is relative to

The **project root** is the registered directory; the **worktree root** is the target checkout. For folder projects, both are the same directory.

| Field                                               | Relative to   |
| --------------------------------------------------- | ------------- |
| `worktrees.hooks.postCreate[].src` (copy, symlink)  | Project root  |
| `worktrees.hooks.postCreate[].dest` (copy, symlink) | Worktree root |
| `worktrees.hooks.postCreate[].cwd` (command)        | Worktree root |
| `commands[].cwd`                                    | Worktree root |
| `commands[].envFiles[]`                             | Worktree root |

Paths must stay relative to their listed root. Command paths are validated when config loads; hook paths and timeout syntax are validated when hooks run.

## Worktree hooks

Git-only `worktrees.hooks.postCreate` hooks run in order after new checkout creation, when trusted and enabled. Three kinds:

- **`copy`** duplicates files from the project root into the worktree. Use it for files a worktree needs its own copy of - `.env` files it will mutate, local caches.
- **`symlink`** links the worktree at a path in the project root. Use it for large, shared, read-mostly things - `node_modules`, model weights, build caches.
- **`command`** runs a shell command in the worktree. Use it for installs, migrations, codegen.

```yaml
worktrees:
  hooks:
    postCreate:
      - type: copy
        src: .env.local
        dest: .env.local

      - type: copy
        src: config/secrets
        dest: config/secrets
        include: ["**/*.json"]
        exclude: ["**/*.example.json"]
        overwrite: false

      - type: symlink
        src: node_modules
        dest: node_modules

      - type: command
        run: pnpm install --offline
        cwd: .
        timeout: 5m
        env:
          CI: "1"
```

`timeout` accepts values like `500ms`, `30s`, `10m`, `1h`, and defaults to `10m`. A hook that exceeds its timeout is terminated.

Hooks tolerate extra fields: a misspelled `overwirte:` is ignored, not rejected. Read hook YAML back carefully after you write it.

## Commands

`commands` defines named shell commands for Git and folder environments.

```yaml
commands:
  - name: dev
    command: pnpm dev
    ports:
      - port: 5173
        paths:
          - label: app
            path: /
          - label: docs
            path: /docs
      - envVar: API_PORT
        paths:
          - label: api
            path: /api
      - port: 9229
    lifecycle:
      activate:
        start: true

  - name: test
    command: pnpm test

  - name: db
    command: docker compose up postgres
    cwd: infra
    envFiles: [".env.local"]
    env:
      POSTGRES_PORT: "5432"
    lifecycle:
      postCreate:
        start: true
      deactivate:
        stop: false
```

Commands run in your login shell's environment. On top of that baseline Isagi layers `envFiles[]` in order, then `env`, so a variable you set in `env` wins over the same name in an environment file, and both win over whatever your shell exported. Isagi's own runtime controls (`PORT`, `HOST`, and `ISAGI_*`) are never inherited from the runtime process, but setting any of them in `envFiles[]` or `env` works normally — a command configured with `env: { PORT: "5173" }` starts with `PORT=5173`.

| Event        | Field   | Default |
| ------------ | ------- | ------- |
| `postCreate` | `start` | `false` |
| `activate`   | `start` | `false` |
| `deactivate` | `stop`  | `true`  |
| `preDelete`  | `stop`  | `true`  |

- `postCreate`: Git checkout creation only, after setup succeeds or is skipped; never registration or recovery.
- `activate.start`: first-start automation only; does not revive exited, failed, or explicitly stopped commands.
- `deactivate.stop`: suspends running commands on leaving. They resume on a user-driven return, not runtime restart; manual Stop clears resume intent.
- `preDelete.stop: false` does not keep commands running after project removal.

### Ports and HTTP URLs

- Each entry declares exactly one of `port` for a fixed port or `envVar` for a port Isagi allocates at launch. Numeric entries such as `ports: [5173]` are invalid.
- Optional `paths` entries contain a `label` and `path` and produce `http://localhost:<port><path>` URLs when the client and runtime run on the same machine. Either port variant may omit `paths`; an allocated pathless port still injects its value but produces no URL.
- An allocated port is injected through its `envVar`, overrides the same key from `envFiles[]`, and cannot collide with explicit `env`. Isagi prefers the previous inactive allocation but does not reserve it.

Two rules the parser enforces strictly, unlike the rest of this file:

- **Command names must be unique**, non-empty, and carry no leading or trailing whitespace.
- **Unknown fields on a command or a lifecycle entry are rejected.** A misspelled `lifecyle:` or `portz:` fails the parse rather than being ignored. This is deliberate - it is the one place where a typo is loud.

## Schema

This is the schema Isagi validates the file against. The field descriptions are authoritative.

```ts
{{PROJECT_CONFIG_SCHEMA}}
```
