---
name: isagi-docs
disable-model-invocation: true
description: Teaches agents how to configure Isagi - its config.yaml files, worktree hooks, commands, pty backend, and workflows. Use when the user mentions Isagi by name, asks what Isagi can configure, or asks for a change to how Isagi behaves. Not for general development work that never mentions Isagi.
metadata:
  version: "{{VERSION}}"
---

# Configuring Isagi

Isagi is a desktop app for resumable, worktree-based development environments. Users configure it
through two YAML files and a directory of TypeScript workflow definitions. That is the whole surface,
and this skill covers all of it.

Use this skill when the user is talking about Isagi or wants Isagi itself to behave differently. Do
not use it for ordinary development work in whatever repository happens to be open.

## Ground rules

**Propose before you write.** Show the exact change - a diff, or the whole file when it is short - and
get a yes before touching anything. Configuration decides how the user's worktrees get built and what
runs inside them; a surprise here costs more than a surprise in application code.

**Editing a hook re-triggers the trust prompt.** Isagi hashes the content of `worktrees.hooks` and
asks the user to trust it before running it. Any edit changes the hash, so the user will be asked to
approve their hooks again on the next worktree they create. Tell them to expect it. It is not a bug,
and it is not something you can suppress.

**Verify every workflow you touch.** Workflows are packages whose verifier publishes a standalone
artifact. After any edit, run the package's verify script described in
[Workflows](references/workflows.md) and fix what it reports. Never tell the user a workflow is ready
before verification succeeds.

**Read the workflow reference before authoring one.** [Workflows](references/workflows.md) covers the
durable execution model, reducer shape, agent lifecycle, judgments, and verification. Use the
installed `@yourtechbudstudio/isagi-workflow-sdk` package for exact types and signatures.

**When Isagi does not configure something, say so plainly.** The surface below is the entire surface.
If the user asks for themes, keybindings, default models, pane layouts, or anything else not listed,
tell them Isagi does not configure it today. Do not invent a config key to be helpful. Most unknown
keys are ignored rather than rejected, so an invented key produces a file that parses, changes
nothing, and leaves the user believing it worked.

## Which feature fits the ask

| The user wants                                                                                                                                             | Use                                | Read                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Files copied or symlinked into every new worktree, or a setup command run once when a worktree is created                                                  | Worktree hooks (`worktrees.hooks`) | [Project config](references/config-project.md)                                            |
| A named command they can run in a worktree, optionally started or stopped as the worktree is created, activated, deactivated, or deleted                   | Commands (`commands`)              | [Project config](references/config-project.md)                                            |
| A different terminal backend for the processes Isagi launches                                                                                              | Runtime config (`pty`)             | [Global config](references/config-global.md)                                              |
| Enabling supported harnesses or maintaining their explicit-only Docs integration                                                                            | Harness policy (`harnesses`)        | [Global config](references/config-global.md)                                              |
| Several agents driven through a repeatable, multi-step process - spawning agents, waiting on their turns, pausing for the user, running headless judgments | A workflow                         | [Workflows](references/workflows.md)                                        |

A one-off task an agent can just do is not a workflow. Workflows earn their cost when the process
repeats, spans hours, must survive an app restart, or needs a human at a specific junction.

## Where configuration lives

| File                                                     | Scope                                                        | When changes take effect                                 |
| -------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| `{{DATA_ROOT}}/config.yaml`                              | Runtime, shared across every project                         | On restart. The setting is read once, when Isagi starts. |
| `.isagi/config.yaml` in the repository root              | One project                                                  | Immediately. Isagi re-reads this file on each operation. |
| `{{DATA_ROOT}}/workflows/<key>/`                         | Workflow package available in every project                  | New runs after a successful verification.                |
| `.isagi/workflows/<key>/` in the repository root         | Workflow package available in this project                   | New runs after a successful verification.                |

When the same workflow key exists in both places, the project copy wins for runs launched from that
project. This is the usual reason a change to a global workflow appears to do nothing.

## References

| Reference                                      | Read when                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Global config](references/config-global.md)   | Changing the pty backend, or explaining what the runtime config file holds.                    |
| [Project config](references/config-project.md) | Writing or editing worktree hooks and commands.                                                |
| [Workflows](references/workflows.md)           | Authoring or reviewing a durable workflow and verifying that it loads.             |

The two config references embed the schema Isagi validates against. The field descriptions in that
schema are authoritative: when the prose and the schema disagree, the schema is right.
