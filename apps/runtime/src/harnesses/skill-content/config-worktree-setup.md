# Worktree setup hooks

`worktrees.hooks.postCreate` in the project root's `.isagi/config.yaml` prepares each new Git checkout. Fields, path roots and the timeout grammar are in the [schema](config-project.schema.ts).

```yaml
worktrees:
  hooks:
    postCreate:
      - type: copy
        src: .env
        dest: .env
      - type: symlink
        src: .cache/models
        dest: .cache/models
      - type: command
        run: pnpm install
        timeout: 10m
```

- `copy` for files each worktree needs its own copy of, such as `.env` files and local secrets; `symlink` for large, shared, read-mostly things such as model weights or build caches; `command` for installs, migrations and codegen.
- Never symlink a directory that a later `command` hook writes into, such as `node_modules` before an install: the write lands in the shared project copy.
- Hooks are read from the project root's checkout. A hook change committed in another worktree has no effect until the project root has it.
- Retried setup reruns every hook, so each must tolerate a partial earlier run.
- Changing a hook asks the user for trust again on the next creation; tell them.
