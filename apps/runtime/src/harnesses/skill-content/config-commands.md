# Commands

`commands` in a worktree's `.isagi/config.yaml` defines named shell commands for that checkout. Fields, lifecycle events and validation are in the [schema](config-project.schema.ts).

```yaml
commands:
  - name: dev
    command: pnpm dev --port $PORT
    ports:
      - envVar: PORT
        paths:
          - label: app
            path: /
    lifecycle:
      activate:
        start: true
  - name: db
    command: docker compose up postgres
    cwd: infra
    envFiles: ['.env.local']
    ports:
      - port: 5432
    lifecycle:
      deactivate:
        stop: false
```

- Give a command an allocated port (`envVar`) when it can run in several worktrees at once, and pass the variable to the tool if it does not read it on its own. Use a fixed `port` only when something outside the worktree expects that number.
- A bare number such as `ports: [5173]` is invalid; each entry is an object.
- Use `deactivate.stop: false` for a service shared across worktrees, such as a database.
- New worktrees get the file from their checkout, so a command meant for every worktree belongs in the committed file on the base branch. An uncommitted file reaches new worktrees only through a [`copy` hook](config-worktree-setup.md).
- A running command keeps the environment and ports it started with; restart it to apply an edit.
