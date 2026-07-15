---
name: isagi-docs
disable-model-invocation: true
description: Configure Isagi project and global settings, or create, modify, review, and verify Isagi workflows. Use when the user mentions Isagi configuration, worktree hooks, commands, pty backends, harness policy, or workflows. Not for ordinary development work that does not change Isagi itself.
metadata:
  version: "{{VERSION}}"
---

# Configure Isagi

Read only the reference that matches the request. Do not load unrelated references. When a request crosses more than one configuration surface, read only those references.

## Choose the reference

| Request | Read |
| --- | --- |
| Copying or linking files into new worktrees; running setup after worktree creation | [Project config](references/config-project.md) for `worktrees` |
| Defining commands and their worktree lifecycle | [Project config](references/config-project.md) for `commands` |
| Selecting the terminal backend | [Global config](references/config-global.md) for `pty` |
| Enabling harnesses or their Docs integration | [Global config](references/config-global.md) for `harnesses` |
| Adding machine-global directories Isagi discovers workflows in | [Global config](references/config-global.md) for `workflows.additionalDirectories` |
| Creating, modifying, or reviewing a workflow | [Workflows](references/workflows.md) |

## Boundaries

- When the user requests a change, make the in-scope change without adding a separate proposal step.
- Warn the user that editing `worktrees.hooks` causes Isagi to ask them to trust the hooks again.
- Finish workflow authoring by running the workflow package's `build` script followed by its `verify` script. A workflow is not complete until both succeed in that order.
- Do not invent configuration keys. If a requested surface is not represented above or in the authoritative schemas, say that Isagi does not configure it today.

## Default locations

| Path | Scope |
| --- | --- |
| `{{DATA_ROOT}}/config.yaml` | Runtime configuration shared by every project |
| `.isagi/config.yaml` | Project configuration committed with the repository |
| `{{DATA_ROOT}}/workflows/<key>/` | Globally discovered workflow package |
| `.isagi/workflows/<key>/` | Project-discovered workflow package |

These are Isagi's built-in discovery locations, not restrictions on where a workflow may be authored. Follow an explicit user-provided target path. Additional machine-global discovery roots can be configured in `workflows.additionalDirectories`; see [Global config](references/config-global.md). Workflow sources are an ordered overlay evaluated from lowest to highest priority — the global data-root workflows, then each configured additional directory in the order listed, then the project's `.isagi/workflows` — and when more than one source defines the same workflow key, the highest-priority source wins.

The configuration references embed the schemas Isagi validates. Their field descriptions are authoritative when prose and schema disagree.
