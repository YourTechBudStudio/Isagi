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

## Additional workflow directories

Isagi discovers workflow packages under the global data root (`{{DATA_ROOT}}/workflows/<key>/`) and under each project (`.isagi/workflows/<key>/`). The `workflows.additionalDirectories` setting adds machine-global collection roots to that discovery without replacing either built-in root.

```yaml
workflows:
  additionalDirectories:
    - ~/isagi-workflows
    - /opt/team/isagi-workflows
```

Each entry is a collection root that contains `<key>/` package directories — the same layout as `{{DATA_ROOT}}/workflows/` — not a path to a single workflow package.

Rules for each entry:

- It must be a native absolute path, or `~` / `~/...` for the current user's home directory. Quote the exact home-directory entry as `"~"` because an unquoted `~` is YAML null. Isagi expands `~` and normalizes the result.
- Relative paths, paths resolved against the config file or the current directory, environment variables, and another user's `~otheruser` are not supported. A malformed entry prevents Isagi from starting.

Precedence follows the source order, from lowest to highest priority: the global data-root workflows first, then each configured directory in the order listed so a later entry outranks an earlier one, then the project's `.isagi/workflows`. When more than one source defines the same workflow key, the highest-priority source owns it; a broken winning package makes that key fail rather than falling back to a lower-priority copy.

A configured directory that does not exist is skipped, and Isagi warns once for it. A configured directory that exists but cannot be read — a file where a directory was expected, or an unreadable path — is a discovery error, not an empty source.

Isagi validates this setting's shape and path rules when it starts, and validates each winning workflow package later — when workflow descriptors are listed and again immediately before a run starts, never at startup. Changes to `workflows.additionalDirectories` take effect only after Isagi restarts.

## Terminal history and cache retention

The top-level `terminal` section controls terminal presentation history and the process-local cache used to keep hidden terminal sessions warm. These settings are global to every project and manual changes take effect after Isagi restarts.

```yaml
terminal:
  scrollbackLines: 5000
  cache:
    idleTtlMinutes: 180
    maxHiddenSessions: 4
    maxEstimatedBufferMiB: 64
```

`scrollbackLines` defaults to `5000` and accepts integers from `0` through `100000`. Zero retains only the active terminal screen.

`idleTtlMinutes` defaults to `180` and accepts integers from `0` through `10080`. `maxHiddenSessions` defaults to `4` and accepts integers from `0` through `32`. `maxEstimatedBufferMiB` defaults to `64` and accepts integers from `0` through `2048`.

Zero for any cache limit makes hidden heavy terminal entries immediately ineligible for retention. It does not delete the small viewport metadata Isagi keeps for the current app process. Visible terminals are never evicted and may temporarily exceed the configured estimated-buffer budget.

Omitting `terminal`, `cache`, or any nested field applies the documented default. A malformed value prevents Isagi from starting. Configure these settings only in `{{DATA_ROOT}}/config.yaml`; `.isagi/config.yaml` is project configuration and does not own terminal history or cache retention.

## Schema

This is the schema Isagi validates the file against. The field descriptions are authoritative.

```ts
{{RUNTIME_CONFIG_SCHEMA}}
```
