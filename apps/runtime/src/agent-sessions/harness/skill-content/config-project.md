# Project config

Worktree hooks and commands, committed with the repository.

## The file

```
.isagi/config.yaml
```

in the root of the user's repository. It is committed, so it applies to everyone who clones the
project.

Isagi re-reads this file on every operation that needs it. **Hook and command edits take effect
immediately** - no restart. The one thing an edit to hooks does trigger is the trust prompt: Isagi
hashes hook content and asks the user to approve it, so any change, including reordering or
whitespace, means the user is asked again the next time they create a worktree. Warn them.

## Two roots, and which one a path is relative to

Isagi creates a worktree for each branch the user works on. The **project root** is the original
checkout. The **worktree root** is the new directory Isagi just created. Hooks exist to carry things
from the first into the second, so the two ends of a hook are relative to different roots. Getting
this backwards is the single most common mistake in this file.

| Field                                               | Relative to   |
| --------------------------------------------------- | ------------- |
| `worktrees.hooks.postCreate[].src` (copy, symlink)  | Project root  |
| `worktrees.hooks.postCreate[].dest` (copy, symlink) | Worktree root |
| `worktrees.hooks.postCreate[].cwd` (command)        | Worktree root |
| `commands[].cwd`                                    | Worktree root |
| `commands[].envFiles[]`                             | Worktree root |

Absolute paths, and relative paths that climb out of their root, are always rejected - but not always
at the same moment. A bad `commands[].cwd` or `envFiles[]` entry fails as soon as Isagi reads the
command catalog. A bad hook path fails later, when the hook actually runs during worktree creation.
So a hooks config that parses is not yet a hooks config that works, and the same is true of a hook
`timeout` whose grammar is only checked at execution.

## Worktree hooks

`worktrees.hooks.postCreate` runs in order, once, right after Isagi creates a worktree. Three kinds:

- **`copy`** duplicates files from the project root into the worktree. Use it for files a worktree
  needs its own copy of - `.env` files it will mutate, local caches.
- **`symlink`** links the worktree at a path in the project root. Use it for large, shared,
  read-mostly things - `node_modules`, model weights, build caches.
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

`timeout` accepts values like `500ms`, `30s`, `10m`, `1h`, and defaults to `10m`. A hook that exceeds
its timeout is terminated.

Hooks tolerate extra fields: a misspelled `overwirte:` is ignored, not rejected. Read hook YAML back
carefully after you write it.

## Commands

`commands` is a catalog of named shell commands for the project. Isagi shows them, runs them, and can
start or stop them at four moments in a worktree's life.

```yaml
commands:
  - name: dev
    command: pnpm dev
    ports: [5173]
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
    ports: [5432]
    lifecycle:
      postCreate:
        start: true
      deactivate:
        stop: false
```

The lifecycle defaults are conservative, and they are asymmetric on purpose: Isagi does not start
things you did not ask it to start, and does stop things when the worktree goes away.

| Event        | Field   | Default |
| ------------ | ------- | ------- |
| `postCreate` | `start` | `false` |
| `activate`   | `start` | `false` |
| `deactivate` | `stop`  | `true`  |
| `preDelete`  | `stop`  | `true`  |

So `dev` above starts whenever the user activates that worktree and stops when they leave it. `db`
starts once at creation and keeps running across worktree switches, because it opts out of the
`deactivate` stop.

`ports` is metadata. It tells Isagi which ports the command is expected to bind so it can show them;
it does not allocate, reserve, or remap anything.

Two rules the parser enforces strictly, unlike the rest of this file:

- **Command names must be unique**, non-empty, and carry no leading or trailing whitespace.
- **Unknown fields on a command or a lifecycle entry are rejected.** A misspelled `lifecyle:` or
  `ports:` fails the parse rather than being ignored. This is deliberate - it is the one place where a
  typo is loud.

## Schema

This is the schema Isagi validates the file against. The field descriptions are authoritative.

```ts
{{PROJECT_CONFIG_SCHEMA}}
```
