# Global config

## Harness policy

The top-level `harnesses` section controls whether Isagi may create new processes for each supported
harness and whether it maintains the reserved, explicit-only global `isagi-docs` integration.
Missing entries and booleans default to `false`. A missing `harnesses` section means onboarding is
incomplete; `harnesses: {}` is a completed policy with no enabled harnesses.

```yaml
harnesses:
  codex:
    enabled: true
    installIsagiDocs: true
```

Disabling a harness or Docs installation does not remove content installed earlier. Isagi replaces
the exact `isagi-docs` target when installation is enabled; edits to that reserved target are not
preserved on reconciliation.

Runtime configuration. One file, shared by every project on this machine.

## The file

```
{{DATA_ROOT}}/config.yaml
```

It may not exist. Isagi runs on defaults when it is missing, so creating it is the normal way to
change a setting for the first time.

Isagi reads the file at startup. The runtime policy API updates the live harness policy after an
accepted write; manual YAML edits take effect on the next restart. PTY backend changes always
require a restart.

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
