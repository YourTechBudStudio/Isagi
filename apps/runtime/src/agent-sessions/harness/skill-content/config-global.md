# Global config

Runtime configuration. One file, shared by every project on this machine.

## The file

```
{{DATA_ROOT}}/config.yaml
```

It may not exist. Isagi runs on defaults when it is missing, so creating it is the normal way to
change a setting for the first time.

Everything in this file is read once, when Isagi starts. **Changing it does nothing until Isagi is
restarted.** Say so when you propose an edit; a user who edits the pty backend and sees no change has
hit exactly this, and will otherwise assume the edit was wrong.

Project-level settings - hooks and commands - do not live here. They live in `.isagi/config.yaml` in
the repository root and are described in [Project config](config-project.md).

## Choosing a pty backend

`node-pty` is the default and the path Isagi is built around. It requires no external process.

`tmux` is an optional transport for the processes Isagi launches. It is not a restoration or
continuity mechanism - Isagi restores sessions from its own durable state either way, and a tmux
server that survives a crash does not change what Isagi recovers. Select it only when the user has a
specific reason and tmux is installed.

```yaml
pty:
  backend: node-pty
```

To switch:

```yaml
pty:
  backend: tmux
```

Omitting `pty`, omitting `backend`, or setting `backend: null` all mean `node-pty`. A `backend` value
that is present but is neither `node-pty` nor `tmux` is rejected, and Isagi will not start with it.

## Schema

This is the schema Isagi validates the file against. The field descriptions are authoritative.

```ts
{{RUNTIME_CONFIG_SCHEMA}}
```
