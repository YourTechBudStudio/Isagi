---
name: isagi-docs
description: Configure Isagi, author or repair Isagi workflows, verify workflow packages, and investigate or reconstruct runs with the isagi CLI. Do not use for ordinary development work merely because it runs inside Isagi.
---

# Isagi

Read only the references the task needs; links are relative to the file they appear in. The config schemas ([global](references/config-global.schema.ts), [project](references/config-project.schema.ts)) and the installed SDK declarations are the reference for every field, default and signature, and they win when prose disagrees. The references add what those cannot say. Follow an explicit user-provided target path over the defaults below.

## Where things live

| What | Path | Takes effect |
| --- | --- | --- |
| Global config | `{{DATA_ROOT}}/config.yaml` (may not exist yet; create it) | Restart Isagi |
| Global workflows | `{{DATA_ROOT}}/workflows/<key>/` | Next listing or launch |
| `isagi` CLI fallback | `{{DATA_ROOT}}/tools/isagi-cli/<version>/bin/isagi` | — |
| Worktree setup hooks | `<project root>/.isagi/config.yaml`, `worktrees.hooks` | Next worktree creation |
| Commands and ports | `<worktree>/.isagi/config.yaml`, `commands` (each worktree reads its own checkout's copy) | Next start of the command |
| Project workflows | `<project root>/.isagi/workflows/<key>/` | Next listing or launch |

`{{DATA_ROOT}}` was written in by the Isagi runtime that last installed this skill. The installed app (data root `~/.isagi`) and a development runtime (`pnpm dev`, which serves the repository's `data/.isagi` instead of `ISAGI_DATA_DIR` or `~/.isagi`) install into the same skill folder, so this path may belong to the other one. When the user means a specific runtime, use its data root. When `ISAGI_HARNESS_ARTIFACT_DIRECTORY` is set (Isagi sets it for the agent sessions it launches), the part before `/sessions/` is the data root of the runtime running you; if it differs from the path above, use it and say so. Never pick another `.isagi` directory by guesswork, and never put global settings in a project's `.isagi/config.yaml`.

The project root is the project's main checkout; from inside an Isagi worktree, it is the first entry of `git worktree list`. Add only the section you change to a config file and keep the rest as it is.

## Configure

| Task | Read |
| --- | --- |
| Theme (`appearance`), terminal history and cache (`terminal`), PTY backend (`pty`), harness enablement and Docs installation (`harnesses`), listen address and port (`server`) | The [global schema](references/config-global.schema.ts); edit that section of the global config |
| Fluidcast voice mode (`fluidcast`): providers, local model servers, speech, summary model, history compaction | [Fluidcast](references/config-fluidcast.md) |
| Copying `.env` files, linking or installing into new worktrees (`worktrees.hooks`) | [Worktree setup](references/config-worktree-setup.md) |
| Named commands, fixed or allocated ports, URLs, start/stop automation (`commands`) | [Commands](references/config-commands.md) |
| Extra workflow discovery directories (`workflows.additionalDirectories`) | [Workflow package](references/workflow-package.md#location-and-discovery) |

## Author workflows

| Task | Read |
| --- | --- |
| Create, modify, build or verify a workflow package | [Workflow package](references/workflow-package.md) |
| Graphs, nodes, waits, routing, state and failure design | [Graphs](references/workflow-graphs.md) |
| Agent sessions, headless classification, prompts and modifiers | [Agents](references/workflow-agents.md) |
| Ready-made shapes: agent turn, reading a reply, classifier, review loop, human-led step | [Recipes](references/workflow-recipes.md) |
| Which worktree and surface a run uses (`placement`) and preparation failures | [Environments](references/workflow-environments.md) |
| Saving files at a boundary (`checkpoint`) | [Checkpoints](references/workflow-checkpoints.md) |

## Operate runs

| Task | Read |
| --- | --- |
| Pause, Resume, Retry, Cancel, and runs after an app restart | [Run recovery](references/run-recovery.md) |
| Read what a run did: tree, prompts and replies, checkpoints, events | [CLI investigation](references/cli-investigate-runs.md) |
| Launch a run from the CLI (`isagi workflows runs launch`), or rebuild a checkpoint in a new worktree and launch there | [CLI reconstruction](references/cli-reconstruct-and-launch.md) |
| Run a runtime yourself (`isagi serve`): address, port, data directory, which setting wins | [CLI serve](references/cli-serve.md) |

Report a request as unsupported when neither the schemas, the SDK nor these references support it; do not infer support from this index alone.
